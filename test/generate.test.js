import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { filterFreeModels } from "../src/openrouter/catalog.js";
import { createOpenRouterClient, classifyStatus } from "../src/openrouter/client.js";
import { prepareBot } from "../src/generate/pipeline.js";
import { openStore } from "../src/server/store.js";
import { consume, hashIp, liveBuckets, poolBuckets, quotaConfig } from "../src/server/quota.js";
import { generateLive, fillPool, refreshCatalog } from "../src/server/service.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/openrouter-models.json", import.meta.url), "utf8"));
const ECONOMY = readFileSync(new URL("../src/bots/economy.js", import.meta.url), "utf8");
const chatty = (code, lang = "javascript") => `Sure! Here's a strong bot:\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\nGood luck in the arena!`;

// A fake OpenRouter: `replies` maps model id -> array of responses (consumed in order).
function fakeClient(replies, models = fixture.data) {
  const calls = [];
  return {
    calls,
    listModels: async () => ({ ok: true, models }),
    complete: async ({ model, messages }) => {
      calls.push({ model, messages });
      const q = replies[model] || [];
      const r = q.length ? q.shift() : { ok: true, content: chatty(ECONOMY) };
      return r.ok === false ? r : { ok: true, modelActual: model, provider: "TestHost", ...r };
    },
  };
}

const cfg = (over = {}) => quotaConfig({ LLM_ARENA_IP_SECRET: "s3cret", ...over });

describe("free-model catalog (real OpenRouter sample)", () => {
  it("keeps only :free AND zero-priced text models, never routers", () => {
    const ids = filterFreeModels(fixture.data).map((m) => m.id);
    expect(ids).toEqual(["cohere/north-mini-code:free", "google/gemma-4-31b-it:free", "liquid/lfm-2.5-2.6b:free"]);
    expect(ids).not.toContain("openrouter/free");
    expect(ids).not.toContain("google/lyria-3-pro-preview"); // zero price but no :free
  });

  it("drops models whose context is too small for the prompt", () => {
    const tiny = [{ id: "a/b:free", pricing: { prompt: "0", completion: "0" }, context_length: 2048 }];
    expect(filterFreeModels(tiny)).toEqual([]);
  });

  it("tracks first_seen / last_seen and deactivates vanished models", async () => {
    const store = openStore();
    await refreshCatalog({ store, client: fakeClient({}) });
    store.syncModels([{ id: "google/gemma-4-31b-it:free", name: "Gemma", contextLength: 262144 }], "2026-12-01T00:00:00Z");
    const rows = Object.fromEntries(store.listModels().map((m) => [m.id, m]));
    expect(rows["google/gemma-4-31b-it:free"].active).toBe(1);
    expect(rows["google/gemma-4-31b-it:free"].last_seen).toBe("2026-12-01T00:00:00Z");
    expect(rows["liquid/lfm-2.5-2.6b:free"].active).toBe(0); // kept in history, inactive
  });
});

describe("OpenRouter client", () => {
  it("locks the model: no fallback list, no provider fallbacks", async () => {
    let sent;
    const fetchImpl = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: "x/y:free", provider: "P", choices: [{ message: { content: "hi" } }] }));
    };
    const r = await createOpenRouterClient({ apiKey: "k", fetchImpl }).complete({ model: "x/y:free", messages: [] });
    expect(r.ok).toBe(true);
    expect(sent.model).toBe("x/y:free");
    expect(sent.models).toBeUndefined();
    expect(sent.provider.allow_fallbacks).toBe(false);
    expect(r.provider).toBe("P");
  });

  it("classifies failures: infra vs stop vs rejected", async () => {
    expect(classifyStatus(429).class).toBe("infra");
    expect(classifyStatus(503).class).toBe("infra");
    expect(classifyStatus(402)).toEqual({ class: "stop", kind: "payment_required" });
    expect(classifyStatus(401).class).toBe("stop");
    expect(classifyStatus(404).class).toBe("rejected");
    const timeout = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    expect((await createOpenRouterClient({ apiKey: "k", fetchImpl: timeout }).complete({ model: "m" })).kind).toBe("timeout");
    const okButError = async () => new Response(JSON.stringify({ error: { code: 429, message: "upstream busy" } }));
    expect((await createOpenRouterClient({ apiKey: "k", fetchImpl: okButError }).complete({ model: "m" })).class).toBe("infra");
    const empty = async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    expect((await createOpenRouterClient({ apiKey: "k", fetchImpl: empty }).complete({ model: "m" })).kind).toBe("empty_response");
  });

  it("refuses to call without an API key", async () => {
    const r = await createOpenRouterClient({ fetchImpl: async () => new Response("{}") }).complete({ model: "m" });
    expect(r).toMatchObject({ ok: false, class: "stop", kind: "missing_api_key" });
  });
});

describe("prepareBot: extract -> normalize -> dry-run", () => {
  it("accepts a chatty reply with a working bot", async () => {
    expect((await prepareBot(chatty(ECONOMY))).status).toBe("valid");
  });

  it("strips TypeScript annotations from a ts block", async () => {
    const ts = "export function loop(state: any, api: any): void { const n: number = 1; api.spawnCreep(); }";
    const r = await prepareBot(chatty(ts, "ts"));
    expect(r).toMatchObject({ status: "valid", normalized: "ts-strip" });
  });

  it("recovers mislabelled TypeScript inside a js block", async () => {
    const ts = "function loop(state: any, api: any): void { api.spawnCreep(); }";
    const r = await prepareBot(chatty(ts, "js"));
    expect(r).toMatchObject({ status: "valid", normalized: "ts-strip-fallback" });
  });

  it("marks prose, crashing and runaway bots invalid", async () => {
    expect(await prepareBot("I'm sorry, I can't write games.")).toMatchObject({ status: "invalid", errorKind: "no_code" });
    expect(await prepareBot(chatty("function loop(s, api){ api.nope(); }"))).toMatchObject({ status: "invalid", errorKind: "runtime_error" });
    expect(await prepareBot(chatty("function loop(){ while(true){} }"))).toMatchObject({ status: "invalid", errorKind: "fuel_exhausted" });
  });
});

describe("quotas", () => {
  it("per-IP live limit, then global live cap", () => {
    const store = openStore();
    const c = cfg({ LLM_ARENA_DAILY_LIMIT: "1", LLM_ARENA_GLOBAL_DAILY_LIMIT: "2" });
    const a = hashIp("1.1.1.1", c.ipSecret);
    const b = hashIp("2.2.2.2", c.ipSecret);
    const z = hashIp("3.3.3.3", c.ipSecret);
    expect(consume(store, liveBuckets(c, a)).ok).toBe(true);
    expect(consume(store, liveBuckets(c, a))).toMatchObject({ ok: false, scope: "live_ip" });
    expect(consume(store, liveBuckets(c, b)).ok).toBe(true);
    expect(consume(store, liveBuckets(c, z))).toMatchObject({ ok: false, scope: "live_global" });
  });

  it("pool can never eat the live reserve; budget resets daily", () => {
    const store = openStore();
    const c = cfg({ LLM_ARENA_ACCOUNT_DAILY: "5", LLM_ARENA_GLOBAL_DAILY_LIMIT: "2" });
    let ok = 0;
    while (consume(store, poolBuckets(c), "2026-11-02").ok) ok++;
    expect(ok).toBe(3); // 5 - 2 reserved for live
    expect(consume(store, liveBuckets(c, hashIp("x", c.ipSecret)), "2026-11-02").ok).toBe(true);
    expect(consume(store, poolBuckets(c), "2026-11-03").ok).toBe(true);
  });

  it("IP hashes are keyed by secret and day (no raw IPs stored)", () => {
    expect(hashIp("1.1.1.1", "s", "2026-11-02")).not.toBe(hashIp("1.1.1.1", "s", "2026-11-03"));
    expect(hashIp("1.1.1.1", "s", "2026-11-02")).not.toContain("1.1.1.1");
    expect(() => hashIp("1.1.1.1", null)).toThrow();
  });
});

describe("generation services", () => {
  it("live generation stores a bot with the real model/provider and respects quota", async () => {
    const store = openStore();
    const client = fakeClient({});
    await refreshCatalog({ store, client });
    const c = cfg();
    const first = await generateLive({ store, client, ip: "9.9.9.9", modelId: "google/gemma-4-31b-it:free", cfg: c });
    expect(first).toMatchObject({ ok: true, status: "valid" });
    expect(store.getBot(first.botId)).toMatchObject({ provider: "TestHost", source: "live", prompt_version: "v1" });
    const second = await generateLive({ store, client, ip: "9.9.9.9", modelId: "google/gemma-4-31b-it:free", cfg: c });
    expect(second).toMatchObject({ ok: false, error: "quota", scope: "live_ip" });
    expect(client.calls.length).toBe(1); // refused before calling OpenRouter
  });

  it("rejects unknown models and missing IP secret", async () => {
    const store = openStore();
    const client = fakeClient({});
    await refreshCatalog({ store, client });
    expect((await generateLive({ store, client, ip: "1", modelId: "openrouter/free", cfg: cfg() })).error).toBe("unknown_model");
    expect((await generateLive({ store, client, ip: "1", modelId: "google/gemma-4-31b-it:free", cfg: quotaConfig({}) })).error).toBe("not_configured");
  });

  it("infrastructure errors store no bot; 402 halts all generation", async () => {
    const store = openStore();
    const client = fakeClient({
      "cohere/north-mini-code:free": [{ ok: false, class: "infra", kind: "rate_limited" }],
      "google/gemma-4-31b-it:free": [{ ok: false, class: "stop", kind: "payment_required" }],
    });
    await refreshCatalog({ store, client });
    const s = await fillPool({ store, client, cfg: cfg(), perModel: 1, sleepMs: 0 });
    // cohere: the 429 stored nothing, the retry succeeded -> exactly one bot
    expect(store.listBots().map((b) => b.model_id)).toEqual(["cohere/north-mini-code:free"]);
    expect(s.stoppedBy).toBe("halt:payment_required");
    expect(s.infra).toBe(1);
    expect(store.listAttempts().map((a) => a.outcome)).toEqual(["infra", "stop"]);
  });

  it("fills the pool per model and records invalid bots for the valid-code share", async () => {
    const store = openStore();
    const client = fakeClient({ "liquid/lfm-2.5-2.6b:free": [{ content: "Sorry, no code." }, { content: chatty("function loop(){ while(1){} }") }] });
    await refreshCatalog({ store, client });
    const s = await fillPool({ store, client, cfg: cfg(), perModel: 2, sleepMs: 0 });
    expect(s.stoppedBy).toBe(null);
    const bots = store.listBots();
    const lfm = bots.filter((b) => b.model_id === "liquid/lfm-2.5-2.6b:free");
    expect(lfm.map((b) => b.status)).toEqual(["invalid", "invalid"]);
    // other models wrote the (identical) economy bot: 1 stored, then duplicate -> move on
    expect(bots.filter((b) => b.status === "valid").length).toBe(2);
  });
});
