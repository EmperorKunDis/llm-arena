// Minimal OpenRouter client. Every failure is classified so the leaderboard can
// separate a model's own failure from infrastructure trouble:
//   infra    — 429, 5xx, timeout, network, empty reply  → retry later, never counted
//   stop     — 402 (balance), 401 (bad key)              → halt all generation
//   rejected — 400/403/404/422 (this model refuses or is gone) → skip the model, not counted
// (403 is per-model on OpenRouter, e.g. "only available on agentic harnesses" — not a key problem.)
// The model is LOCKED: no `models` fallback list and no provider fallbacks.

const BASE = "https://openrouter.ai/api/v1";

export function classifyStatus(status) {
  if (status === 429 || status === 408) return { class: "infra", kind: "rate_limited" };
  if (status >= 500) return { class: "infra", kind: "upstream_error" };
  if (status === 402) return { class: "stop", kind: "payment_required" };
  if (status === 401) return { class: "stop", kind: "auth_failed" };
  if (status === 403) return { class: "rejected", kind: "model_forbidden" };
  if (status === 404) return { class: "rejected", kind: "model_not_found" };
  return { class: "rejected", kind: "request_rejected" };
}

export function createOpenRouterClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 240_000, // whole request incl. body: free models can write for 2+ minutes
  referer = "https://arena.svanda.tech",
  title = "LLM Arena",
} = {}) {
  const headers = () => ({
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    "HTTP-Referer": referer,
    "X-Title": title,
  });

  // The timeout covers the WHOLE exchange including the body: OpenRouter sends
  // headers immediately and then streams the reply, so a header-only timeout
  // never fires while a slow model is still writing.
  async function request(path, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${BASE}${path}`, { ...init, signal: ctrl.signal });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
      return { res, json };
    } catch (e) {
      return { netError: e?.name === "AbortError" ? "timeout" : "network_error", message: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listModels() {
      const { res, json, netError, message } = await request("/models", { method: "GET", headers: headers() });
      if (netError) return { ok: false, class: "infra", kind: netError, message };
      if (!res.ok) return { ok: false, ...classifyStatus(res.status), status: res.status };
      return { ok: true, models: json?.data || [] };
    },

    // Reasoning models spend tokens thinking before they answer: a low cap cut
    // bots off mid-line in Phase 0, so allow a long reply and ask for low effort.
    // With `onDelta` the reply is STREAMED: every chunk of reasoning/code is
    // passed on as it arrives, so the site can show the model writing live.
    async complete({ model, messages, maxTokens = 16000, temperature = 0.2, onDelta = null }) {
      if (!apiKey) return { ok: false, class: "stop", kind: "missing_api_key" };
      const body = {
        model, // exactly one model; deliberately no `models` fallback array
        messages,
        max_tokens: maxTokens,
        temperature,
        provider: { allow_fallbacks: false },
        reasoning: { effort: "low" },
        ...(onDelta ? { stream: true } : {}),
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        let res;
        try {
          res = await fetchImpl(`${BASE}/chat/completions`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } catch (e) {
          return { ok: false, class: "infra", kind: e?.name === "AbortError" ? "timeout" : "network_error", message: String(e?.message || e) };
        }
        const isStream = (res.headers.get("content-type") || "").includes("text/event-stream");
        if (!res.ok || !isStream) {
          let json = null;
          try {
            json = JSON.parse(await res.text());
          } catch {
            /* non-JSON */
          }
          return fromJson(res, json, model);
        }
        return await fromStream(res, model, onDelta);
      } catch (e) {
        return { ok: false, class: "infra", kind: e?.name === "AbortError" ? "timeout" : "stream_error", message: String(e?.message || e).slice(0, 200) };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  function fromJson(res, json, model) {
    if (!res.ok) {
      const e = json?.error || {};
      const raw = e.metadata?.raw ? ` | ${typeof e.metadata.raw === "string" ? e.metadata.raw : JSON.stringify(e.metadata.raw)}` : "";
      return { ok: false, ...classifyStatus(res.status), status: res.status, message: `${e.message || ""}${raw}`.slice(0, 400) };
    }
    if (!json) return { ok: false, class: "infra", kind: "bad_response" };
    // OpenRouter can return 200 with an error object (e.g. upstream rate limit).
    if (json.error) {
      const c = classifyStatus(Number(json.error.code) || 502);
      return { ok: false, ...c, status: Number(json.error.code) || 502, message: String(json.error.message || "").slice(0, 300) };
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.trim() === "") return { ok: false, class: "infra", kind: "empty_response" };
    return {
      ok: true,
      content,
      modelActual: json.model || model,
      provider: json.provider || null,
      usage: json.usage || null,
      finishReason: choice?.finish_reason || null,
    };
  }

  // Server-sent events: "data: {chunk}" lines, ": comment" keep-alives, "data: [DONE]".
  async function fromStream(res, model, onDelta) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoning = "";
    let finishReason = null;
    let modelActual = model;
    let provider = null;
    let usage = null;
    let error = null;
    const handle = (line) => {
      if (!line.startsWith("data:")) return false;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return true;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return false;
      }
      if (chunk.error) error = chunk.error;
      if (chunk.model) modelActual = chunk.model;
      if (chunk.provider) provider = chunk.provider;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      const d = choice?.delta || {};
      if (typeof d.reasoning === "string" && d.reasoning) {
        reasoning += d.reasoning;
        onDelta({ reasoning: d.reasoning });
      }
      if (typeof d.content === "string" && d.content) {
        content += d.content;
        onDelta({ content: d.content });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      return false;
    };
    let done = false;
    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line && handle(line)) {
          done = true;
          break;
        }
      }
    }
    if (buf.trim()) handle(buf.trim());
    if (error) {
      const c = classifyStatus(Number(error.code) || 502);
      return { ok: false, ...c, status: Number(error.code) || 502, message: String(error.message || "").slice(0, 300) };
    }
    if (content.trim() === "") {
      if (!reasoning.trim()) return { ok: false, class: "infra", kind: "empty_response" };
      // Some models put their whole answer into the reasoning channel. That is the
      // model's own output: hand it on (marked) instead of retrying forever, which
      // would burn the shared daily quota.
      return { ok: true, content: reasoning, fromReasoning: true, modelActual, provider, usage, finishReason, reasoningChars: reasoning.length };
    }
    return { ok: true, content, modelActual, provider, usage, finishReason, reasoningChars: reasoning.length };
  }
}
