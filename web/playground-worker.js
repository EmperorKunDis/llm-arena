// Playground preview: plays a test match of the visitor's OWN bot in the visitor's
// OWN browser, with the same deterministic engine as the server. This is only a
// preview; when a bot is submitted, the server runs it exclusively inside the
// QuickJS sandbox. The page terminates this worker if a bot loops forever.
import { createGame, createApi, buildView, step, scoreOf } from "./engine/engine.js";

function compile(code, label) {
  const script = String(code)
    .replace(/^﻿/, "")
    .replace(/\bexport\s*\{[^}]*\}\s*;?/g, "")
    .replace(/\bexport\s+default\s+/g, "module.exports.loop = ")
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, "");
  let factory;
  try {
    factory = new Function(
      "module",
      "exports",
      `${script}\n;return typeof loop === "function" ? loop : (module.exports && module.exports.loop);`,
    );
  } catch (e) {
    throw Object.assign(new Error(`${label}: syntax error — ${e.message}`), { kind: "syntax_error" });
  }
  const mod = { exports: {} };
  const fn = factory(mod, mod.exports);
  if (typeof fn !== "function")
    throw Object.assign(new Error(`${label}: no loop(state, api) function found`), { kind: "no_loop" });
  return fn;
}

self.onmessage = ({ data }) => {
  const { seed, code0, code1 } = data;
  let bots;
  try {
    bots = [compile(code0, "Your bot"), compile(code1, "Opponent")];
  } catch (e) {
    return self.postMessage({ error: { kind: e.kind || "load_error", message: e.message, side: /Opponent/.test(e.message) ? 1 : 0 } });
  }
  const state = createGame(seed);
  const record = { seed, opts: {}, ticks: [] };
  let error = null;
  while (!state.over) {
    const perTick = [[], []];
    for (let pi = 0; pi < 2; pi++) {
      if (state.players[pi].dead) continue;
      const api = createApi(state, pi);
      try {
        bots[pi](buildView(state, pi), api);
      } catch (e) {
        error = { kind: "runtime_error", side: pi, tick: state.tick, message: String(e?.message || e) };
        break;
      }
      perTick[pi] = api.cmds;
    }
    if (error) break;
    record.ticks.push(perTick);
    step(state, perTick[0], perTick[1]);
    if (state.tick % 250 === 0) self.postMessage({ progress: state.tick });
  }
  const scores = [scoreOf(state.players[0]), scoreOf(state.players[1])];
  const result = error
    ? { winner: 1 - error.side, reason: "model_error", forfeit: error.side, scores, ticks: state.tick }
    : { winner: state.winner, reason: state.reason, scores, ticks: state.tick };
  self.postMessage({ record, result, error });
};
