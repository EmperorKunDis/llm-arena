// Duels: two models write their bots AT THE SAME TIME (both streams visible
// live), then the two fresh bots play each other twice on the same map with
// sides swapped. A side whose code cannot run loses — the contest is literally
// "which model writes the better bot".
import { randomUUID } from "node:crypto";
import { generateBot } from "../generate/pipeline.js";
import { playMatch, pairSeed } from "./arena.js";

export function createDuels({ keep = 30 } = {}) {
  const duels = new Map();
  return {
    duels,
    start(modelA, modelB, source) {
      const finished = [...duels.values()].filter((d) => d.state === "done").sort((a, b) => b.finishedAt - a.finishedAt);
      for (const d of finished.slice(keep)) duels.delete(d.id);
      const d = { id: randomUUID(), state: "writing", source, models: [modelA, modelB], jobs: [null, null], startedAt: Date.now(), result: null };
      duels.set(d.id, d);
      return d;
    },
    get: (id) => duels.get(id),
    list: () => [...duels.values()].sort((a, b) => b.startedAt - a.startedAt),
  };
}

export function duelView(d, jobs, { since = [0, 0], tail = 0 } = {}) {
  return {
    duelId: d.id,
    state: d.state,
    source: d.source,
    models: d.models,
    elapsedSeconds: Math.round(((d.finishedAt || Date.now()) - d.startedAt) / 1000),
    sides: d.jobs.map((j, i) => (j ? jobs.view(j, tail ? { tail } : { since: since[i] || 0 }) : null)),
    result: d.result,
  };
}

/** Run a full duel. `runner` lets tests play matches in-process. */
export async function runDuel({ store, client, jobs, duels, modelA, modelB, source = "live", runner }) {
  const d = duels.start(modelA, modelB, source);
  const done = (async () => {
    const outs = await Promise.all(
      d.models.map((modelId, i) => {
        const job = jobs.start({ modelId, source: `duel-${source}` });
        d.jobs[i] = job;
        return generateBot({ modelId, client, store, source: source === "live" ? "live" : "pool", onDelta: jobs.onDelta(job) })
          .catch((e) => ({ stored: false, outcome: "infra", kind: "internal_error", message: String(e?.message || e) }))
          .then((out) => (jobs.finish(job, { ok: out.stored, ...out }), out));
      }),
    );
    d.state = "fighting";
    const sides = outs.map((o, i) => ({
      model: d.models[i],
      botId: o.botId ?? null,
      status: o.stored ? o.status : null,
      outcome: o.outcome,
      kind: o.kind ?? null,
    }));
    const valid = sides.map((s) => s.status === "valid");
    let result;
    if (valid[0] && valid[1]) {
      const seed = pairSeed(sides[0].botId, sides[1].botId);
      const opts = runner ? { runner } : {};
      const m1 = await playMatch(store, { bot0: sides[0].botId, bot1: sides[1].botId, seed }, opts);
      const m2 = await playMatch(store, { bot0: sides[1].botId, bot1: sides[0].botId, seed }, opts);
      const r1 = store.getMatch(m1);
      const r2 = store.getMatch(m2);
      const points = [0, 0];
      const score = [0, 0];
      // r1: A is side 0; r2: A is side 1
      for (const [r, aSide] of [
        [r1, 0],
        [r2, 1],
      ]) {
        if (r.status !== "done") continue;
        const sc = JSON.parse(r.scores || "[0,0]");
        score[0] += sc[aSide];
        score[1] += sc[1 - aSide];
        if (r.winner === null) (points[0] += 0.5), (points[1] += 0.5);
        else if (r.winner === aSide) points[0] += 1;
        else points[1] += 1;
      }
      const winner = points[0] !== points[1] ? (points[0] > points[1] ? 0 : 1) : score[0] !== score[1] ? (score[0] > score[1] ? 0 : 1) : null;
      result = { sides, matches: [m1, m2], points, score, winner, reason: "played" };
    } else if (valid[0] || valid[1]) {
      result = { sides, matches: [], winner: valid[0] ? 0 : 1, reason: "opponent_code_failed" };
    } else {
      result = { sides, matches: [], winner: null, reason: "both_failed" };
    }
    d.result = result;
    d.state = "done";
    d.finishedAt = Date.now();
    return d;
  })();
  return { duel: d, done };
}

/**
 * Pick the next two models for an automatic duel: the active models with the
 * fewest bots for the current prompt first; models that recently refused
 * requests (403/404/400) are skipped for a while.
 */
export function nextPair(store, promptVersion, skipUntil = new Map(), now = Date.now()) {
  const models = store
    .listModels({ activeOnly: true })
    .filter((m) => !(skipUntil.get(m.id) > now))
    .map((m) => ({ id: m.id, n: store.countBots(m.id, promptVersion) }))
    .sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
  return models.length >= 2 ? [models[0].id, models[1].id] : null;
}
