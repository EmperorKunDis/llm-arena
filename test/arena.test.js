import { describe, it, expect } from "vitest";
import { rate, bradleyTerry } from "../src/server/rating.js";
import { openStore } from "../src/server/store.js";
import {
  seedReferenceBots,
  pendingMatches,
  runPending,
  playMatch,
  leaderboard,
  decodeRecord,
} from "../src/server/arena.js";
import { runSandboxedMatch } from "../src/runner/sandboxed-match.js";
import { replayMatch } from "../src/runner/replay.js";

// In-process runner (same contract as runMatchIsolated) to keep tests fast.
const inProcess = async (job) => {
  const { result, record } = await runSandboxedMatch(job.seed, job.code0, job.code1);
  return { ok: true, result, record };
};

const series = (a, b, aWins, bWins, draws = 0) => [
  ...Array(aWins).fill({ a, b, score: 1 }),
  ...Array(bWins).fill({ a, b, score: 0 }),
  ...Array(draws).fill({ a, b, score: 0.5 }),
];

describe("Bradley-Terry rating", () => {
  it("recovers a clear ordering", () => {
    const games = [...series("A", "B", 8, 2), ...series("B", "C", 8, 2), ...series("A", "C", 9, 1)];
    expect(rate(games, new Set(["A", "B", "C"])).map((r) => r.id)).toEqual(["A", "B", "C"]);
  });

  it("is independent of match order", () => {
    const games = [...series("A", "B", 6, 4), ...series("B", "C", 3, 7, 2), ...series("A", "C", 5, 5)];
    const shuffled = [...games].reverse();
    const p = new Set(["A", "B", "C"]);
    expect(rate(shuffled, p, { bootstrap: 0 }).map((r) => r.rating)).toEqual(
      rate(games, p, { bootstrap: 0 }).map((r) => r.rating),
    );
  });

  it("evenly matched players sit at the anchor; draws are half wins", () => {
    const r = rate(series("A", "B", 5, 5, 4), new Set(["A", "B"]), { bootstrap: 0 });
    expect(r[0].rating).toBe(1500);
    expect(r[1].rating).toBe(1500);
    expect(r[0].draws).toBe(4);
  });

  it("keeps an unbeaten player finite thanks to the prior", () => {
    const p = bradleyTerry(series("A", "B", 10, 0), new Set(["A", "B"]));
    expect(Number.isFinite(p.get("A"))).toBe(true);
    expect(p.get("A")).toBeGreaterThan(p.get("B"));
  });

  it("is deterministic and its interval narrows with more games", () => {
    const p = new Set(["A", "B"]);
    const few = rate(series("A", "B", 3, 1), p);
    const many = rate(series("A", "B", 30, 10), p);
    expect(rate(series("A", "B", 3, 1), p)).toEqual(few);
    const width = (rows) => rows[0].high - rows[0].low;
    expect(width(many)).toBeLessThan(width(few));
  });
});

describe("arena: matchmaking, play and leaderboard", () => {
  it("each pair plays twice with swapped sides on the same seed", () => {
    const store = openStore();
    expect(seedReferenceBots(store)).toBe(4);
    expect(seedReferenceBots(store)).toBe(0); // idempotent
    const pending = pendingMatches(store);
    expect(pending.length).toBe(12); // C(4,2) pairs x 2 orientations
    const byPair = new Map();
    for (const m of pending) {
      const k = [m.bot0, m.bot1].sort().join("-");
      byPair.set(k, [...(byPair.get(k) || []), m]);
    }
    for (const [, [x, y]] of byPair) {
      expect(x.seed).toBe(y.seed);
      expect([x.bot0, x.bot1]).toEqual([y.bot1, y.bot0]);
    }
  });

  it("plays everything, stores replayable records and ranks the reference bots", async () => {
    const store = openStore();
    seedReferenceBots(store);
    expect(await runPending(store, { runner: inProcess })).toBe(12);
    expect(pendingMatches(store)).toEqual([]);

    const m = store.listMatches({ status: "done" })[0];
    const full = store.getMatch(m.id);
    const record = decodeRecord(full);
    expect(replayMatch(record).scores).toEqual(JSON.parse(full.scores));

    const board = leaderboard(store);
    const ids = board.map((r) => r.id);
    // The working bots lead; random never harvests, so it is exactly as weak as
    // idle (they draw each other and lose the rest) — the shared floor.
    expect(new Set(ids.slice(0, 2))).toEqual(new Set(["reference/economy", "reference/rush"]));
    expect(new Set(ids.slice(2))).toEqual(new Set(["reference/idle", "reference/random"]));
    expect(board[2].rating).toBe(board[3].rating);
    expect(board.every((r) => r.games === 6)).toBe(true); // 3 opponents x 2 sides
  });

  it("infrastructure errors are stored but never rated, and get retried", async () => {
    const store = openStore();
    seedReferenceBots(store);
    const job = pendingMatches(store)[0];
    const failing = async () => ({ ok: false, infrastructure: true, error: { kind: "runner_timeout" } });
    await playMatch(store, job, { runner: failing });
    expect(store.listMatches()[0].status).toBe("infra_error");
    expect(pendingMatches(store)).toContainEqual(job); // still pending
    expect(leaderboard(store).every((r) => r.games === 0)).toBe(true);
  });

  it("rates only current-prompt bots while retaining reference and user opponents", () => {
    const store = openStore();
    const bot = (modelId, promptVersion, source = "pool") => store.insertBot({
      modelId, promptVersion, source, status: "valid", code: `${modelId}-${promptVersion}`,
    });
    const currentA = bot("a:free", "current");
    const currentB = bot("b:free", "current");
    const reference = bot("reference/idle", "reference", "reference");
    const user = bot("user/example", "user", "user");
    const oldA = bot("a:free", "old"); // same model ID, different bot cohort
    const oldOnly = bot("old-only:free", "old");
    const game = (bot0, bot1, winner) => store.insertMatch({ bot0, bot1, winner, seed: 1, status: "done" });
    game(currentA, currentB, 0);
    game(reference, currentA, 1);
    game(currentA, user, 0);
    game(oldA, oldOnly, 0);
    game(oldA, currentB, 0);
    game(oldOnly, reference, 0);

    const rows = leaderboard(store, "current");
    expect(rows.map((r) => r.id).sort()).toEqual(["a:free", "b:free", "reference/idle", "user/example"]);
    expect(rows.find((r) => r.id === "a:free")).toMatchObject({ games: 3, wins: 3, losses: 0, bots: 1 });
    expect(rows.find((r) => r.id === "b:free")).toMatchObject({ games: 1, losses: 1 });
    expect(rows.find((r) => r.id === "reference/idle")).toMatchObject({ games: 1, losses: 1 });
    expect(rows.find((r) => r.id === "user/example")).toMatchObject({ games: 1, losses: 1, user: true });
    store.close();
  });

  it("a bot that crashes mid-match loses; models with only invalid code show up unrated", async () => {
    const store = openStore();
    seedReferenceBots(store);
    store.syncModels([{ id: "x/crasher:free", name: "Crasher", contextLength: 9999 }]);
    store.insertBot({
      modelId: "x/crasher:free",
      promptVersion: "v2",
      source: "pool",
      status: "valid",
      code: "export function loop(s){ if (s.tick > 3) throw new Error('boom'); }",
    });
    store.syncModels([
      { id: "x/crasher:free", name: "Crasher", contextLength: 9999 },
      { id: "x/broken:free", name: "Broken", contextLength: 9999 },
    ]);
    store.insertBot({ modelId: "x/broken:free", promptVersion: "v2", source: "pool", status: "invalid", errorKind: "no_code" });
    await runPending(store, { runner: inProcess });
    const board = leaderboard(store);
    const crasher = board.find((r) => r.id === "x/crasher:free");
    expect(crasher.losses).toBe(crasher.games); // every crash is a loss
    const broken = board.find((r) => r.id === "x/broken:free");
    expect(broken).toMatchObject({ rating: null, validShare: 0, bots: 1 });
  });
});
