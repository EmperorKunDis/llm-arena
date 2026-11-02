import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createOpenRouterClient } from "../src/openrouter/client.js";
import { createJobs } from "../src/server/jobs.js";
import { openStore } from "../src/server/store.js";
import { submitUserBot, slugName, SUBMIT_PER_IP_DAILY } from "../src/server/submit.js";
import { seedReferenceBots, runPending, leaderboard, opponents } from "../src/server/arena.js";
import { quotaConfig } from "../src/server/quota.js";
import { runSandboxedMatch } from "../src/runner/sandboxed-match.js";
import { createArenaServer } from "../src/server/http.js";

const ECONOMY = readFileSync(new URL("../src/bots/economy.js", import.meta.url), "utf8");
const cfg = quotaConfig({ LLM_ARENA_IP_SECRET: "s" });
const inProcess = async (job) => {
  const { result, record } = await runSandboxedMatch(job.seed, job.code0, job.code1);
  return { ok: true, result, record };
};

function sse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("streaming from OpenRouter", () => {
  it("passes reasoning and code to onDelta as they arrive and assembles the reply", async () => {
    const parts = [
      ": OPENROUTER PROCESSING\n\n",
      'data: {"model":"m/x:free","provider":"Host","choices":[{"delta":{"reasoning":"plan..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"```js\\nfunction lo"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"op(){}\\n```"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    let sent;
    const fetchImpl = async (_u, init) => ((sent = JSON.parse(init.body)), sse(parts));
    const deltas = [];
    const r = await createOpenRouterClient({ apiKey: "k", fetchImpl }).complete({
      model: "m/x:free",
      messages: [],
      onDelta: (d) => deltas.push(d),
    });
    expect(sent.stream).toBe(true);
    expect(r).toMatchObject({ ok: true, content: "```js\nfunction loop(){}\n```", provider: "Host", finishReason: "stop" });
    expect(deltas).toEqual([{ reasoning: "plan..." }, { content: "```js\nfunction lo" }, { content: "op(){}\n```" }]);
  });

  it("classifies an error that arrives mid-stream and a reasoning-only reply", async () => {
    const err = async () => sse(['data: {"error":{"code":429,"message":"busy"}}\n\n']);
    expect(await createOpenRouterClient({ apiKey: "k", fetchImpl: err }).complete({ model: "m", onDelta: () => {} })).toMatchObject({
      ok: false,
      class: "infra",
    });
    const think = async () => sse(['data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\n', "data: [DONE]\n\n"]);
    expect(await createOpenRouterClient({ apiKey: "k", fetchImpl: think }).complete({ model: "m", onDelta: () => {} })).toMatchObject({
      ok: false,
      kind: "only_reasoning",
    });
  });
});

describe("jobs registry", () => {
  it("keeps the streamed text and serves increments", () => {
    const jobs = createJobs();
    const j = jobs.start({ modelId: "m", source: "live" });
    const push = jobs.onDelta(j);
    push({ reasoning: "think" });
    push({ content: "abc" });
    push({ content: "def" });
    expect(jobs.view(j, { since: 3 }).content).toBe("def");
    expect(jobs.activity().running[0]).toMatchObject({ model: "m", contentLength: 6, reasoningLength: 5 });
    jobs.finish(j, { ok: true, status: "valid", botId: 7 });
    expect(jobs.view(j)).toMatchObject({ state: "done", status: "valid", botId: 7 });
    expect(jobs.activity().running).toEqual([]);
    expect(jobs.activity().recent[0].botId).toBe(7);
  });
});

describe("user-submitted agents", () => {
  it("validates names and enforces the daily limit", async () => {
    expect(slugName("Martin's Bot 1")).toBe("martin-s-bot-1");
    expect(slugName("ab")).toBe(null);
    const store = openStore();
    expect((await submitUserBot({ store, ip: "1", name: "reference-x", code: ECONOMY, cfg })).error).toBe("bad_name");
    for (let i = 0; i < SUBMIT_PER_IP_DAILY; i++)
      expect((await submitUserBot({ store, ip: "1", name: "spam", code: `${ECONOMY}\n// v${i}`, cfg })).ok).toBe(true);
    expect((await submitUserBot({ store, ip: "1", name: "spam", code: ECONOMY + "//x", cfg })).error).toBe("quota");
  });

  it("broken code is stored as invalid; a valid agent plays and is ranked", async () => {
    const store = openStore();
    seedReferenceBots(store);
    expect(await submitUserBot({ store, ip: "2", name: "broken", code: "function loop(){ while(1){} }", cfg })).toMatchObject({
      ok: true,
      status: "invalid",
      errorKind: "fuel_exhausted",
    });
    const ok = await submitUserBot({ store, ip: "2", name: "my-agent", code: ECONOMY + "\n// mine", cfg });
    expect(ok).toMatchObject({ ok: true, status: "valid", model: "user/my-agent" });
    await runPending(store, { runner: inProcess });
    const row = leaderboard(store).find((r) => r.id === "user/my-agent");
    expect(row).toMatchObject({ user: true, games: 8 }); // 4 references x 2 sides
    expect(opponents(store).map((o) => o.model)).toContain("user/my-agent");
  });
});

describe("HTTP: activity, opponents, submit, worker CSP", () => {
  it("serves the new endpoints", async () => {
    const store = openStore();
    seedReferenceBots(store);
    const server = createArenaServer({ store, client: {}, env: { LLM_ARENA_IP_SECRET: "s" } });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      expect(await (await fetch(base + "/api/activity")).json()).toEqual({ running: [], recent: [] });
      const opp = await (await fetch(base + "/api/opponents")).json();
      expect(opp.opponents.length).toBe(4);
      const sub = await fetch(base + "/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "web-agent", code: ECONOMY }),
      });
      expect(sub.status).toBe(201);
      const w = await fetch(base + "/playground-worker.js");
      expect(w.headers.get("content-security-policy")).toContain("'unsafe-eval'");
      const page = await fetch(base + "/playground.html");
      expect(page.headers.get("content-security-policy")).not.toContain("unsafe-eval");
    } finally {
      server.close();
    }
  });
});
