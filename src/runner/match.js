// Runs a full match between two bots and records a replay. In production the
// bot functions come from sandboxed LLM code; here they are plain functions.
// A bot that throws forfeits immediately (counts as a model error / loss).

import { createGame, createApi, buildView, step, scoreOf } from "../engine/engine.js";
import { RULES } from "../engine/constants.js";

export function runMatch(seed, bot0, bot1, opts = {}) {
  const state = createGame(seed, opts);
  const bots = [bot0, bot1];
  const record = { seed: state.seed, opts, ticks: [] };
  let forfeit = null; // player index that crashed

  while (!state.over) {
    const perTick = [[], []];
    for (let pi = 0; pi < 2 && forfeit === null; pi++) {
      if (state.players[pi].dead) continue;
      const api = createApi(state, pi);
      try {
        bots[pi](buildView(state, pi), api);
      } catch {
        forfeit = pi;
        break;
      }
      perTick[pi] = api.cmds;
    }
    if (forfeit !== null) break;
    record.ticks.push(perTick);
    step(state, perTick[0], perTick[1]);
  }

  const scores = [scoreOf(state.players[0]), scoreOf(state.players[1])];
  let result;
  if (forfeit !== null) {
    result = { winner: 1 - forfeit, reason: "forfeit", forfeit, scores, ticks: state.tick };
  } else {
    result = { winner: state.winner, reason: state.reason, forfeit: null, scores, ticks: state.tick };
  }
  record.result = result;
  return { state, record, result };
}

export { RULES };
