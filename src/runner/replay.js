// Re-runs a recorded match from its command log alone (no bots). Because the
// engine is deterministic, the replay reproduces the original result exactly —
// this is what the browser does, so it never executes untrusted bot code.

import { createGame, step, scoreOf } from "../engine/engine.js";

export function replayMatch(record) {
  const state = createGame(record.seed, record.opts || {});
  for (const [cmds0, cmds1] of record.ticks) {
    if (state.over) break;
    step(state, cmds0, cmds1);
  }
  return { state, scores: [scoreOf(state.players[0]), scoreOf(state.players[1])] };
}
