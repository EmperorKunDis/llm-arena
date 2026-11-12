// Matchmaking, match execution and the leaderboard.
//
// Fairness: every pair of bots (from different models) plays TWICE on the same
// seed with sides swapped. Matches are computed server-side only; a client never
// submits a result. Only 'done' matches feed the rating:
//   - model error inside a match  -> a normal loss for that bot (status 'done')
//   - both bots failed            -> 'invalid', not rated
//   - runner timeout/crash        -> 'infra_error', retried, never rated

import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROMPT_VERSION } from "../generate/prompt.js";
import { runMatchIsolated } from "../runner/isolated.js";
import { rate } from "./rating.js";

const BOTS_DIR = fileURLToPath(new URL("../bots/", import.meta.url));
export const PROVISIONAL_GAMES = 10;

/** Register the reference bots (idle/random/rush/economy) as fixed yardsticks. */
export function seedReferenceBots(store) {
  let added = 0;
  for (const file of readdirSync(BOTS_DIR).filter((f) => f.endsWith(".js")).sort()) {
    const name = file.replace(/\.js$/, "");
    const id = store.insertBot({
      modelId: `reference/${name}`,
      promptVersion: "reference",
      source: "reference",
      status: "valid",
      code: readFileSync(BOTS_DIR + file, "utf8"),
    });
    if (id !== null) added++;
  }
  return added;
}

/** Bots that take part in rated play: valid bots of the current prompt, references and user agents. */
export function ratedBots(store, promptVersion = PROMPT_VERSION) {
  return store
    .listBots({ status: "valid" })
    .filter((b) => b.prompt_version === promptVersion || b.source === "reference" || b.source === "user");
}

// Deterministic seed per pair, so a pair always meets on the same map.
export function pairSeed(a, b) {
  let h = 2166136261;
  for (const ch of `${Math.min(a, b)}:${Math.max(a, b)}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** All (bot0, bot1, seed) orientations that still need a counted result. */
export function pendingMatches(store, promptVersion = PROMPT_VERSION) {
  const bots = ratedBots(store, promptVersion);
  const settled = new Set(
    store
      .listMatches()
      .filter((m) => m.status === "done" || m.status === "invalid")
      .map((m) => `${m.bot0}>${m.bot1}`),
  );
  const out = [];
  for (let i = 0; i < bots.length; i++)
    for (let j = i + 1; j < bots.length; j++) {
      const a = bots[i];
      const b = bots[j];
      if (a.model_id === b.model_id) continue; // self-play tells us nothing about the model
      const seed = pairSeed(a.id, b.id);
      for (const [x, y] of [
        [a, b],
        [b, a],
      ])
        if (!settled.has(`${x.id}>${y.id}`)) out.push({ bot0: x.id, bot1: y.id, seed });
    }
  return out;
}

/** Run one scheduled match in an isolated process and store the outcome. */
export async function playMatch(store, job, { runner = runMatchIsolated, timeoutMs } = {}) {
  const b0 = store.getBot(job.bot0);
  const b1 = store.getBot(job.bot1);
  const pairKey = `${Math.min(job.bot0, job.bot1)}-${Math.max(job.bot0, job.bot1)}`;
  const res = await runner({ seed: job.seed, code0: b0.code, code1: b1.code }, timeoutMs ? { timeoutMs } : {});
  if (!res.ok) {
    return store.insertMatch({ ...job, pairKey, status: "infra_error", errors: [res.error, null] });
  }
  const r = res.result;
  return store.insertMatch({
    ...job,
    pairKey,
    status: r.valid ? "done" : "invalid",
    winner: r.winner,
    reason: r.reason,
    forfeit: r.forfeit ?? null,
    errors: r.errors,
    scores: r.scores,
    ticks: r.ticks,
    recordGz: gzipSync(JSON.stringify(res.record)),
  });
}

/** Play pending matches until none remain (or `limit` is reached). */
export async function runPending(store, { limit = Infinity, runner, log = () => {} } = {}) {
  let played = 0;
  for (const job of pendingMatches(store)) {
    if (played >= limit) break;
    const id = await playMatch(store, job, { runner });
    played++;
    log(id, job);
  }
  return played;
}

export function decodeRecord(match) {
  return match?.record_gz ? JSON.parse(gunzipSync(Buffer.from(match.record_gz)).toString("utf8")) : null;
}

/** Model-level leaderboard: Bradley-Terry over all counted matches. */
export function leaderboard(store, promptVersion = PROMPT_VERSION) {
  const bots = new Map(store.listBots().map((b) => [b.id, b]));
  const cohort = ratedBots(store, promptVersion);
  const cohortIds = new Set(cohort.map((b) => b.id));
  const games = [];
  for (const m of store.listMatches({ status: "done" })) {
    // Filter by bot, not model: the same model can have old-prompt bots whose
    // historical games must not enter the current prompt's rating.
    if (!cohortIds.has(m.bot0) || !cohortIds.has(m.bot1)) continue;
    const a = bots.get(m.bot0)?.model_id;
    const b = bots.get(m.bot1)?.model_id;
    if (!a || !b || a === b) continue;
    games.push({ a, b, score: m.winner === 0 ? 1 : m.winner === 1 ? 0 : 0.5 });
  }
  const catalog = new Map(store.listModels().map((m) => [m.id, m]));
  const players = new Set(cohort.map((b) => b.model_id));
  for (const g of games) players.add(g.a), players.add(g.b);

  const generated = new Map();
  for (const b of bots.values()) {
    if (b.source === "reference" || (b.source !== "user" && b.prompt_version !== promptVersion)) continue;
    const s = generated.get(b.model_id) || { total: 0, valid: 0 };
    s.total++;
    if (b.status === "valid") s.valid++;
    generated.set(b.model_id, s);
  }
  // Models that only ever produced invalid code still appear (with no rating).
  const unrated = [...generated.keys()].filter((id) => !players.has(id));

  const rows = rate(games, players).map((r) => {
    const gen = generated.get(r.id);
    const isRef = r.id.startsWith("reference/");
    const isUser = r.id.startsWith("user/");
    return {
      ...r,
      reference: isRef,
      user: isUser,
      provisional: r.games < PROVISIONAL_GAMES,
      bots: gen?.total ?? (isRef ? 1 : 0),
      validBots: gen?.valid ?? (isRef ? 1 : 0),
      validShare: gen ? gen.valid / gen.total : isRef ? 1 : null,
      active: isRef || isUser ? true : catalog.get(r.id)?.active === 1,
    };
  });
  for (const id of unrated) {
    const gen = generated.get(id);
    rows.push({
      id,
      rating: null,
      low: null,
      high: null,
      wins: 0,
      losses: 0,
      draws: 0,
      games: 0,
      reference: false,
      user: id.startsWith("user/"),
      provisional: true,
      bots: gen.total,
      validBots: gen.valid,
      validShare: gen.valid / gen.total,
      active: id.startsWith("user/") || catalog.get(id)?.active === 1,
    });
  }
  return rows;
}

/** Opponents for the in-browser playground: reference bots + the newest valid bot of each model/agent. */
export function opponents(store, promptVersion = PROMPT_VERSION) {
  const latest = new Map();
  for (const b of ratedBots(store, promptVersion)) latest.set(b.model_id, b);
  return [...latest.values()]
    .sort((x, y) => (x.source === "reference") - (y.source === "reference") || (x.model_id < y.model_id ? -1 : 1))
    .map((b) => ({ id: b.id, model: b.model_id, source: b.source, code: b.code }));
}
