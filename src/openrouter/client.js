// Minimal OpenRouter client. Every failure is classified so the leaderboard can
// separate a model's own failure from infrastructure trouble:
//   infra    — 429, 5xx, timeout, network, empty reply  → retry later, never counted
//   stop     — 402 (balance), 401/403 (key)             → halt all generation
//   rejected — 400/404/422 (model gone / request refused) → not counted, model flagged
// The model is LOCKED: no `models` fallback list and no provider fallbacks.

const BASE = "https://openrouter.ai/api/v1";

export function classifyStatus(status) {
  if (status === 429 || status === 408) return { class: "infra", kind: "rate_limited" };
  if (status >= 500) return { class: "infra", kind: "upstream_error" };
  if (status === 402) return { class: "stop", kind: "payment_required" };
  if (status === 401 || status === 403) return { class: "stop", kind: "auth_failed" };
  if (status === 404) return { class: "rejected", kind: "model_not_found" };
  return { class: "rejected", kind: "request_rejected" };
}

export function createOpenRouterClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  referer = "https://arena.svanda.tech",
  title = "LLM Arena",
} = {}) {
  const headers = () => ({
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    "HTTP-Referer": referer,
    "X-Title": title,
  });

  async function request(path, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return { res: await fetchImpl(`${BASE}${path}`, { ...init, signal: ctrl.signal }) };
    } catch (e) {
      return { netError: e?.name === "AbortError" ? "timeout" : "network_error", message: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listModels() {
      const { res, netError, message } = await request("/models", { method: "GET", headers: headers() });
      if (netError) return { ok: false, class: "infra", kind: netError, message };
      if (!res.ok) return { ok: false, ...classifyStatus(res.status), status: res.status };
      const body = await res.json();
      return { ok: true, models: body.data || [] };
    },

    async complete({ model, messages, maxTokens = 4000, temperature = 0.2 }) {
      if (!apiKey) return { ok: false, class: "stop", kind: "missing_api_key" };
      const body = {
        model, // exactly one model; deliberately no `models` fallback array
        messages,
        max_tokens: maxTokens,
        temperature,
        provider: { allow_fallbacks: false },
      };
      const { res, netError, message } = await request("/chat/completions", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (netError) return { ok: false, class: "infra", kind: netError, message };
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.json())?.error?.message || "";
        } catch {
          /* ignore */
        }
        return { ok: false, ...classifyStatus(res.status), status: res.status, message: String(detail).slice(0, 300) };
      }
      let json;
      try {
        json = await res.json();
      } catch {
        return { ok: false, class: "infra", kind: "bad_response" };
      }
      // OpenRouter can return 200 with an error object (e.g. upstream rate limit).
      if (json?.error) {
        const c = classifyStatus(Number(json.error.code) || 502);
        return { ok: false, ...c, status: Number(json.error.code) || 502, message: String(json.error.message || "").slice(0, 300) };
      }
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "")
        return { ok: false, class: "infra", kind: "empty_response" };
      return {
        ok: true,
        content,
        modelActual: json.model || model,
        provider: json.provider || null,
        usage: json.usage || null,
      };
    },
  };
}
