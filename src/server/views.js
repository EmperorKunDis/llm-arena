// JSON views shared by the HTTP API and the static (GitHub Pages) build, so both
// deployments expose exactly the same data.
import { decodeRecord, leaderboard, PROVISIONAL_GAMES } from "./arena.js";
import { PROMPT_VERSION } from "../generate/prompt.js";

export const publicBot = (b, withCode = false) =>
  b && {
    id: b.id,
    model: b.model_id,
    modelActual: b.model_actual,
    provider: b.provider,
    promptVersion: b.prompt_version,
    source: b.source,
    status: b.status,
    errorKind: b.error_kind,
    normalized: b.normalized,
    createdAt: b.created_at,
    ...(withCode ? { code: b.code, errorMessage: b.error_message } : {}),
  };

export const leaderboardView = (store) => ({
  promptVersion: PROMPT_VERSION,
  provisionalGames: PROVISIONAL_GAMES,
  rows: leaderboard(store),
});

export function matchesView(store, limit = 30) {
  const bots = new Map(store.listBots().map((b) => [b.id, b]));
  return {
    matches: store
      .listMatches({ status: "done" })
      .slice(-limit)
      .reverse()
      .map((m) => ({
        id: m.id,
        bot0: { id: m.bot0, model: bots.get(m.bot0)?.model_id },
        bot1: { id: m.bot1, model: bots.get(m.bot1)?.model_id },
        winner: m.winner,
        reason: m.reason,
        forfeit: m.forfeit,
        scores: JSON.parse(m.scores || "null"),
        ticks: m.ticks,
        createdAt: m.created_at,
      })),
  };
}

export function matchDetailView(store, id) {
  const m = store.getMatch(id);
  if (!m || m.status !== "done") return null;
  return {
    id: m.id,
    seed: m.seed,
    winner: m.winner,
    reason: m.reason,
    forfeit: m.forfeit,
    errors: JSON.parse(m.errors || "null"),
    scores: JSON.parse(m.scores || "null"),
    ticks: m.ticks,
    bots: [publicBot(store.getBot(m.bot0)), publicBot(store.getBot(m.bot1))],
    record: decodeRecord(m),
  };
}
