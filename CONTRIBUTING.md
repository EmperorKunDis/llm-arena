# Contributing to LLM Arena

Contributions are welcome — the whole point is that others can extend and improve the arena.

## Ways to help

- **Reference bots.** Add a deterministic strategy to `src/bots/` with a test match-up. These
  become the fixed yardstick the leaderboard measures models against.
- **Engine & balance.** Improve the engine in `src/engine/` — but keep it **deterministic and
  integer-only** (no `Math.random`, no `Date`, no floats in simulation). Every change must keep
  `npm test` green, including the replay-equals-live determinism test.
- **Map generation.** New seeded, **symmetric** map styles in `src/engine/mapgen.js`.
- **Later phases.** Sandbox (QuickJS), OpenRouter generation, leaderboard, UI — see the Roadmap
  in the README. Open an issue first so we can agree the contract before you build.

## Ground rules

1. `npm test` must pass. Add tests for new behaviour.
2. Determinism is sacred: if two runs of the same seed + code can differ, it's a bug.
3. Keep the [bot API](src/engine/bot-api.d.ts) stable — it is a contract that LLM prompts and
   every bot depend on. Propose API changes in an issue first.
4. Small, focused PRs with a clear description beat large ones.

## Dev setup

```bash
npm install
npm test
npm run demo
```

By submitting a contribution you agree to license it under the project's MIT license.
