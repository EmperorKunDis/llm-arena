// Plays a match between two untrusted bot sources, each in its own QuickJS VM.
// Produces the same result/record shape as runMatch(), plus error details, so
// the leaderboard can tell a MODEL error (counts as a loss) from a match where
// both bots failed (invalid, not counted).

import { createGame, buildView, step, scoreOf } from "../engine/engine.js";
import { createBotSandbox } from "../sandbox/quickjs.js";

export async function runSandboxedMatch(seed, code0, code1, opts = {}) {
  const state = createGame(seed, opts.map || {});
  const view0 = buildView(state, 0);
  // Both sides share the same Math.random seed: a symmetric bot gets the same
  // "randomness" on either side, so randomness cannot favour one side.
  const vmSeed = (seed >>> 0) ^ 0xa5a5a5a5;
  const record = { seed: state.seed, opts: opts.map || {}, ticks: [] };
  const boxes = await Promise.all([
    createBotSandbox(code0, { seed: vmSeed, limits: opts.limits, map: view0.map }),
    createBotSandbox(code1, { seed: vmSeed, limits: opts.limits, map: view0.map }),
  ]);

  const finish = (result) => {
    for (const b of boxes) if (b.ok) b.dispose();
    record.result = result;
    return { state, record, result };
  };
  const scores = () => [scoreOf(state.players[0]), scoreOf(state.players[1])];

  // Load-time failures.
  const loadErr = boxes.map((b) => (b.ok ? null : b.error));
  if (loadErr[0] && loadErr[1])
    return finish({ valid: false, winner: null, reason: "both_failed", errors: loadErr, scores: [0, 0], ticks: 0 });
  for (let pi = 0; pi < 2; pi++)
    if (loadErr[pi])
      return finish({
        valid: true,
        winner: 1 - pi,
        reason: "model_error",
        forfeit: pi,
        errors: loadErr,
        scores: [0, 0],
        ticks: 0,
      });

  while (!state.over) {
    const outs = [0, 1].map((pi) =>
      state.players[pi].dead ? { cmds: [] } : boxes[pi].tick(buildView(state, pi)),
    );
    const errs = outs.map((o) => o.error || null);
    if (errs[0] && errs[1])
      return finish({ valid: false, winner: null, reason: "both_failed", errors: errs, scores: scores(), ticks: state.tick });
    const failed = errs[0] ? 0 : errs[1] ? 1 : -1;
    if (failed >= 0)
      return finish({
        valid: true,
        winner: 1 - failed,
        reason: "model_error",
        forfeit: failed,
        errors: errs,
        scores: scores(),
        ticks: state.tick,
      });
    record.ticks.push([outs[0].cmds, outs[1].cmds]);
    step(state, outs[0].cmds, outs[1].cmds);
  }

  return finish({
    valid: true,
    winner: state.winner,
    reason: state.reason,
    forfeit: null,
    errors: [null, null],
    scores: scores(),
    ticks: state.tick,
    fuel: boxes.map((b) => b.stats().matchFuel),
  });
}
