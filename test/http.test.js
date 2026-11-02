import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { openStore } from "../src/server/store.js";
import { createArenaServer } from "../src/server/http.js";
import { seedReferenceBots, runPending } from "../src/server/arena.js";
import { runSandboxedMatch } from "../src/runner/sandboxed-match.js";

const ECONOMY = readFileSync(new URL("../src/bots/economy.js", import.meta.url), "utf8");
const inProcess = async (job) => {
  const { result, record } = await runSandboxedMatch(job.seed, job.code0, job.code1);
  return { ok: true, result, record };
};
const fakeClient = {
  complete: async ({ model }) => ({ ok: true, content: "```js\n" + ECONOMY + "\n```", modelActual: model, provider: "T" }),
  listModels: async () => ({ ok: true, models: [] }),
};

let server;
let base;
let store;
beforeAll(async () => {
  store = openStore();
  seedReferenceBots(store);
  store.syncModels([{ id: "a/model:free", name: "A", contextLength: 99999 }]);
  await runPending(store, { runner: inProcess });
  server = createArenaServer({
    store,
    client: fakeClient,
    env: { OPENROUTER_API_KEY: "test", LLM_ARENA_IP_SECRET: "s", LLM_ARENA_DAILY_LIMIT: "1" },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

const get = (p) => fetch(base + p);

describe("HTTP API", () => {
  it("serves the leaderboard and matches", async () => {
    const lb = await (await get("/api/leaderboard")).json();
    expect(lb.rows.length).toBe(4);
    const { matches } = await (await get("/api/matches")).json();
    expect(matches.length).toBe(12);
    const detail = await (await get(`/api/matches/${matches[0].id}`)).json();
    expect(detail.record.ticks.length).toBeGreaterThan(0);
    expect(detail.bots[0].code).toBeUndefined(); // code only via /api/bots/:id
  });

  it("live generation stores a bot, then enforces the per-IP limit", async () => {
    const post = () =>
      fetch(base + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: "a/model:free" }),
      });
    const first = await post();
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body.status).toBe("valid");
    const bot = await (await get(`/api/bots/${body.botId}`)).json();
    expect(bot.code).toContain("function loop");
    expect((await post()).status).toBe(429);
  });

  it("rejects bad input", async () => {
    const r = await fetch(base + "/api/generate", { method: "POST", body: "x".repeat(5000) });
    expect(r.status).toBe(413);
    const r2 = await fetch(base + "/api/generate", { method: "POST", body: "{not json" });
    expect(r2.status).toBe(400);
    expect((await get("/api/matches/999999")).status).toBe(404);
  });
});

describe("static files and headers", () => {
  it("serves the frontend and the engine modules", async () => {
    expect((await get("/")).headers.get("content-type")).toContain("text/html");
    expect(await (await get("/engine/engine.js")).text()).toContain("export function step");
  });

  it("does not leak files outside the web and engine folders", async () => {
    for (const p of ["/..%2f..%2fpackage.json", "/engine/..%2f..%2f.env.example", "/engine/..%2fserver%2fstore.js"]) {
      const r = await get(p);
      expect([403, 404]).toContain(r.status);
    }
  });

  it("sends a strict CSP that allows framing only by svanda.tech", async () => {
    const csp = (await get("/")).headers.get("content-security-policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'self' https://svanda.tech https://www.svanda.tech");
    expect(csp).not.toContain("unsafe-inline");
  });
});
