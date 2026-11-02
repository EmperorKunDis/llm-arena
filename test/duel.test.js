import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openStore } from "../src/server/store.js";
import { createJobs } from "../src/server/jobs.js";
import { createDuels, runDuel, nextPair, duelView } from "../src/server/duel.js";
import { consume, duelBuckets, hashIp, quotaConfig } from "../src/server/quota.js";
import { runSandboxedMatch } from "../src/runner/sandboxed-match.js";
import { createArenaServer } from "../src/server/http.js";

const src = (n) => readFileSync(new URL(`../src/bots/${n}.js`, import.meta.url), "utf8");
const fence = (code) => "Here you go:\n```js\n" + code + "\n```";
const inProcess = async (job) => {
  const { result, record } = await runSandboxedMatch(job.seed, job.code0, job.code1);
  return { ok: true, result, record };
};
// fake OpenRouter: each model streams its reply in two chunks
const clientFor = (replies) => ({
  complete: async ({ model, onDelta }) => {
    const r = replies[model];
    if (r.ok === false) return r;
    const half = Math.floor(r.length / 2);
    onDelta?.({ content: r.slice(0, half) });
    onDelta?.({ content: r.slice(half) });
    return { ok: true, content: r, modelActual: model, provider: "T" };
  },
});
const setup = () => {
  const store = openStore();
  store.syncModels([
    { id: "a/rush:free", name: "A", contextLength: 99999 },
    { id: "b/eco:free", name: "B", contextLength: 99999 },
    { id: "c/bad:free", name: "C", contextLength: 99999 },
  ]);
  return { store, jobs: createJobs(), duels: createDuels() };
};

describe("duels", () => {
  it("both models write at the same time, then play twice with sides swapped", async () => {
    const { store, jobs, duels } = setup();
    const client = clientFor({ "a/rush:free": fence(src("rush")), "b/eco:free": fence(src("economy")) });
    const { duel, done } = await runDuel({ store, client, jobs, duels, modelA: "a/rush:free", modelB: "b/eco:free", runner: inProcess });
    expect(duel.jobs.every(Boolean)).toBe(true); // two parallel generation jobs
    const d = await done;
    expect(d.state).toBe("done");
    expect(d.result.reason).toBe("played");
    expect(d.result.matches.length).toBe(2);
    const [m1, m2] = d.result.matches.map((id) => store.getMatch(id));
    expect([m1.bot0, m1.bot1]).toEqual([m2.bot1, m2.bot0]);
    expect(m1.seed).toBe(m2.seed);
    expect([0, 1, null]).toContain(d.result.winner);
    expect(d.result.points[0] + d.result.points[1]).toBe(2);
    const view = duelView(d, jobs);
    expect(view.sides[0].content).toContain("function loop"); // streamed text kept
  });

  it("a side whose code cannot run loses the duel", async () => {
    const { store, jobs, duels } = setup();
    const client = clientFor({ "a/rush:free": fence(src("rush")), "c/bad:free": fence("function loop(){ while(1){} }") });
    const { done } = await runDuel({ store, client, jobs, duels, modelA: "c/bad:free", modelB: "a/rush:free", runner: inProcess });
    const d = await done;
    expect(d.result).toMatchObject({ winner: 1, reason: "opponent_code_failed" });
    expect(d.result.sides[0]).toMatchObject({ status: "invalid", kind: "fuel_exhausted" });
  });

  it("both failing is a void duel", async () => {
    const { store, jobs, duels } = setup();
    const client = clientFor({ "a/rush:free": "no code", "c/bad:free": { ok: false, class: "infra", kind: "rate_limited" } });
    const d = await (await runDuel({ store, client, jobs, duels, modelA: "a/rush:free", modelB: "c/bad:free", runner: inProcess })).done;
    expect(d.result).toMatchObject({ winner: null, reason: "both_failed" });
  });

  it("a duel costs two requests of the shared budget but one per-visitor duel", () => {
    const store = openStore();
    const cfg = quotaConfig({ LLM_ARENA_IP_SECRET: "s", LLM_ARENA_GLOBAL_DAILY_LIMIT: "3", LLM_ARENA_DAILY_LIMIT: "5" });
    expect(consume(store, duelBuckets(cfg, hashIp("1", "s"))).ok).toBe(true); // 2 of 3
    expect(consume(store, duelBuckets(cfg, hashIp("2", "s")))).toMatchObject({ ok: false, scope: "live_global" }); // 4 > 3
  });

  it("auto-duels pick the models with the fewest bots and skip refusing ones", () => {
    const { store } = setup();
    store.insertBot({ modelId: "a/rush:free", promptVersion: "v2", source: "pool", status: "valid", code: "x" });
    expect(nextPair(store, "v2")).toEqual(["b/eco:free", "c/bad:free"]);
    expect(nextPair(store, "v2", new Map([["c/bad:free", Date.now() + 1e6]]))).toEqual(["b/eco:free", "a/rush:free"]);
  });
});

describe("HTTP duel flow", () => {
  it("POST /api/duel returns at once; polling shows both sides and the result", async () => {
    const { store, jobs, duels } = setup();
    const client = clientFor({ "a/rush:free": fence(src("rush")), "b/eco:free": fence(src("economy")) });
    const server = createArenaServer({
      store,
      client,
      jobs,
      duels,
      runner: inProcess,
      env: { OPENROUTER_API_KEY: "k", LLM_ARENA_IP_SECRET: "s" },
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(base + "/api/duel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelA: "a/rush:free", modelB: "b/eco:free" }),
      });
      expect(res.status).toBe(202);
      const { duelId } = await res.json();
      let v;
      for (let i = 0; i < 200; i++) {
        v = await (await fetch(`${base}/api/duels/${duelId}`)).json();
        if (v.state === "done") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(v.state).toBe("done");
      expect(v.sides.length).toBe(2);
      expect(v.result.matches.length).toBe(2);
      const act = await (await fetch(base + "/api/activity")).json();
      expect(act.recentDuels[0].duelId).toBe(duelId);
      const same = await fetch(base + "/api/duel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelA: "a/rush:free", modelB: "a/rush:free" }),
      });
      expect(same.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
