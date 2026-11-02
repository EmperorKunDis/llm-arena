import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runSandboxedMatch } from "../src/runner/sandboxed-match.js";
import { runMatchIsolated } from "../src/runner/isolated.js";
import { runMatch } from "../src/runner/match.js";
import { replayMatch } from "../src/runner/replay.js";
import { snapshot } from "../src/engine/engine.js";
import { loop as economyFn } from "../src/bots/economy.js";
import { loop as rushFn } from "../src/bots/rush.js";

const src = (name) => readFileSync(new URL(`../src/bots/${name}.js`, import.meta.url), "utf8");
const ECONOMY = src("economy");
const RUSH = src("rush");
const IDLE = src("idle");

// Short matches: the rush bot destroys a passive spawn in well under 100 ticks.
const vsRush = (code) => runSandboxedMatch(7, code, RUSH);

describe("sandbox equals trusted runner", () => {
  it("reference bots produce the identical match inside QuickJS", async () => {
    const plain = runMatch(42, economyFn, rushFn);
    const boxed = await runSandboxedMatch(42, ECONOMY, RUSH);
    expect(boxed.result.valid).toBe(true);
    expect(boxed.result.winner).toBe(plain.result.winner);
    expect(boxed.result.reason).toBe(plain.result.reason);
    expect(boxed.result.scores).toEqual(plain.result.scores);
    expect(boxed.record.ticks).toEqual(plain.record.ticks);
  });

  it("a sandboxed match replays exactly from its command log", async () => {
    const { state, record } = await runSandboxedMatch(99, RUSH, ECONOMY);
    expect(snapshot(replayMatch(record).state)).toEqual(snapshot(state));
  });

  it("is deterministic, including fuel accounting and Math.random", async () => {
    const randomBot = `export function loop(s, api) {
      if (s.me.spawn.energy >= s.me.costs.creep) api.spawnCreep();
      for (const c of s.me.creeps) api.move(c.id, Math.floor(Math.random() * 8));
    }`;
    const a = await runSandboxedMatch(5, randomBot, RUSH);
    const b = await runSandboxedMatch(5, randomBot, RUSH);
    expect(a.record.ticks).toEqual(b.record.ticks);
    expect(a.result).toEqual(b.result);
  });
});

describe("module styles", () => {
  it("accepts CommonJS (Screeps-style) module.exports.loop", async () => {
    const cjs = ECONOMY.replace("export function loop", "module.exports.loop = function");
    const { result } = await runSandboxedMatch(42, cjs, RUSH);
    expect(result.reason).not.toBe("model_error");
  });

  it("accepts export default", async () => {
    const { result } = await vsRush("export default function loop(state, api) {}");
    expect(result.reason).not.toBe("model_error");
  });
});

describe("hostile and broken bots forfeit (model error)", () => {
  const cases = [
    ["infinite loop", "export function loop() { while (true) {} }", "fuel_exhausted"],
    [
      "memory hog",
      "export function loop() { const a = []; while (true) a.push(new Array(100000).fill(7)); }",
      "out_of_memory",
    ],
    ["unbounded recursion", "function f(n) { return f(n + 1) + 1; } export function loop() { f(0); }", "stack_overflow"],
    ["network access", "export function loop() { fetch('https://evil.example'); }", "runtime_error"],
    ["calls a non-existent API", "export function loop(s, api) { api.teleport('c1'); }", "runtime_error"],
    ["uses the disabled clock", "export function loop() { new Date(); }", "runtime_error"],
    ["syntax error", "export function loop( {", "syntax_error"],
    ["no loop exported", "const x = 1;", "no_loop"],
  ];
  for (const [name, code, kind] of cases) {
    it(name, async () => {
      const { result } = await vsRush(code);
      expect(result.valid).toBe(true);
      expect(result.reason).toBe("model_error");
      expect(result.forfeit).toBe(0);
      expect(result.winner).toBe(1);
      expect(result.errors[0].kind).toBe(kind);
    });
  }

  it("even if recursion escapes the VM (unsafe stack limit), it is a loss, not a runner crash", async () => {
    const deep = "function f(n) { return f(n + 1) + 1; } export function loop() { f(0); }";
    const { result } = await runSandboxedMatch(7, deep, RUSH, { limits: { stackBytes: 512 * 1024 } });
    expect(result.reason).toBe("model_error");
    expect(result.forfeit).toBe(0);
    expect(result.errors[0].kind).toBe("stack_overflow");
  });

  it("two broken bots make an invalid match (not counted)", async () => {
    const { result } = await runSandboxedMatch(7, "export function loop( {", "nope(");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("both_failed");
  });
});

describe("no escape from the VM", () => {
  it("host globals do not exist and the bot keeps playing", async () => {
    const probe = `
      export function loop() {
        const seen = [typeof process, typeof require, typeof fetch, typeof globalThis.std,
          typeof globalThis.os, (function () {}).constructor("return typeof process")()];
        if (seen.some((t) => t !== "undefined")) throw new Error("escaped: " + seen.join(","));
        if (Date.now() !== 0) throw new Error("clock leaked");
      }`;
    const { result } = await vsRush(probe);
    expect(result.reason).not.toBe("model_error");
  });

  it("tampering with its own globals only hurts the bot", async () => {
    const tamper = `Array.prototype.push = function () { return 0; };
      JSON.stringify = function () { return "not json"; };
      export function loop(s, api) { api.spawnCreep(); }`;
    const { result } = await vsRush(tamper);
    expect(result.valid).toBe(true); // host keeps working; captured JSON refs survive
    expect([].concat([1]).length).toBe(1);
  });
});

describe("process isolation", () => {
  it("an isolated child process returns the same result", async () => {
    const inProc = await runSandboxedMatch(42, ECONOMY, RUSH);
    const iso = await runMatchIsolated({ seed: 42, code0: ECONOMY, code1: RUSH });
    expect(iso.ok).toBe(true);
    expect(iso.result).toEqual(inProc.result);
  });

  it("a runner timeout is an infrastructure error, not a model loss", async () => {
    const iso = await runMatchIsolated({ seed: 1, code0: IDLE, code1: IDLE }, { timeoutMs: 1 });
    expect(iso.ok).toBe(false);
    expect(iso.infrastructure).toBe(true);
    expect(iso.error.kind).toBe("runner_timeout");
  });
});
