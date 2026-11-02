import { describe, it, expect } from "vitest";
import { createGame, step, buildView, createApi, snapshot } from "../src/engine/engine.js";
import { generateMap } from "../src/engine/mapgen.js";
import { runMatch } from "../src/runner/match.js";
import { replayMatch } from "../src/runner/replay.js";
import { loop as idle } from "../src/bots/idle.js";
import { loop as random } from "../src/bots/random.js";
import { loop as rush } from "../src/bots/rush.js";
import { loop as economy } from "../src/bots/economy.js";

describe("mapgen", () => {
  it("is point-symmetric and reproducible", () => {
    const a = generateMap(777);
    const b = generateMap(777);
    expect(a.tiles).toEqual(b.tiles);
    // 180° rotational symmetry of the terrain.
    const { width: w, height: h, tiles } = a;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        expect(tiles[y * w + x]).toBe(tiles[(h - 1 - y) * w + (w - 1 - x)]);
    // Spawns mirror each other.
    expect(a.spawns[1]).toEqual({ x: w - 1 - a.spawns[0].x, y: h - 1 - a.spawns[0].y });
  });
});

describe("determinism", () => {
  it("same seed + same bots => identical match", () => {
    const r1 = runMatch(42, economy, rush);
    const r2 = runMatch(42, economy, rush);
    expect(r1.result).toEqual(r2.result);
    expect(snapshot(r1.state)).toEqual(snapshot(r2.state));
    expect(r1.record.ticks).toEqual(r2.record.ticks);
  });

  it("replay from the command log reproduces the live final state", () => {
    const { state, record } = runMatch(99, rush, economy);
    const replay = replayMatch(record);
    expect(snapshot(replay.state)).toEqual(snapshot(state));
  });

  it("different seeds generally differ", () => {
    const a = runMatch(1, economy, rush);
    const b = runMatch(2, economy, rush);
    expect(snapshot(a.state)).not.toEqual(snapshot(b.state));
  });
});

describe("fairness", () => {
  // Per-match side bias is cancelled at the leaderboard by playing each pair
  // twice with swapped sides (see README). What the engine itself guarantees:
  it("idle self-play is a scoreless draw", () => {
    for (const seed of [3, 17, 2024]) {
      const { result } = runMatch(seed, idle, idle);
      expect(result.winner).toBe(null);
      expect(result.scores).toEqual([0, 0]);
    }
  });

  it("a decisive bot wins from either side (no fixed-side advantage)", () => {
    for (const seed of [3, 17, 2024]) {
      expect(runMatch(seed, economy, idle).result.winner).toBe(0);
      expect(runMatch(seed, idle, economy).result.winner).toBe(1);
    }
  });
});

describe("outcomes", () => {
  it("a working economy beats an idle opponent", () => {
    const { result } = runMatch(5, economy, idle);
    expect(result.winner).toBe(0);
  });

  it("two idle bots draw with zero score", () => {
    const { result } = runMatch(5, idle, idle);
    expect(result.winner).toBe(null);
    expect(result.scores).toEqual([0, 0]);
  });

  it("a crashing bot forfeits and the opponent wins", () => {
    const boom = () => {
      throw new Error("bad bot");
    };
    const { result } = runMatch(5, boom, economy);
    expect(result.reason).toBe("forfeit");
    expect(result.forfeit).toBe(0);
    expect(result.winner).toBe(1);
  });
});

describe("integer invariants", () => {
  it("never produces non-integer positions, hp or energy", () => {
    const { state } = runMatch(123, rush, economy);
    const snap = snapshot(state);
    const ints = [];
    for (const p of snap.players) {
      ints.push(p.spawn.x, p.spawn.y, p.spawn.hp, p.spawn.energy, p.harvestedTotal, p.killScore);
      for (const c of p.creeps) ints.push(c.x, c.y, c.hp, c.carry);
      for (const s of p.structures) ints.push(s.x, s.y, s.hp);
    }
    for (const n of ints) expect(Number.isInteger(n)).toBe(true);
  });
});

describe("api guards", () => {
  it("ignores malformed commands without throwing", () => {
    const state = createGame(1);
    const api = createApi(state, 0);
    api.move("nope", 99); // invalid dir
    api.move("nope", -1);
    api.moveTo("nope", 1.5, 2); // non-integer
    expect(api.cmds.length).toBe(0);
    const before = snapshot(state);
    step(state, api.cmds, []);
    // one tick passed, but nothing else changed catastrophically
    expect(state.tick).toBe(before.tick + 1);
    expect(buildView(state, 0).me.index).toBe(0);
  });
});
