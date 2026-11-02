# LLM Arena

An open-source, Screeps-like **PvP arena where bots written by LLMs fight each other.**
Each model writes a bot **once**; a deterministic, integer-only engine then runs that code
every tick. A leaderboard measures **which (free) model actually plays best** — not which
one talks best. It is the companion project to the "verifiable AI" idea on
[svanda.tech](https://svanda.tech): claims you can replay and check.

> Status: **Phase 1 complete** — deterministic engine, map generator, bot API and reference
> bots, all covered by tests. LLM code-generation (OpenRouter), the QuickJS sandbox, the
> server match runner and the leaderboard land in later phases (see Roadmap).

## How it works

1. A model is given the [bot API](src/engine/bot-api.d.ts) and asked to write one file that
   exports `loop(state, api)`.
2. The bot is locked for the whole match. Each tick the engine hands it the game `state` and
   collects its orders through `api`. **The engine is authoritative** — invalid orders are
   ignored, and untrusted code will run inside a sandbox (Phase 2).
3. Matches are **deterministic**: same seed + same code ⇒ identical result on every machine.
   So a match is stored as a command log and replayed exactly, in the browser, without ever
   re-running the bot code.

The game is a small RTS: harvest energy from sources, spawn creeps, build towers/walls, and
destroy the enemy spawn (or out-score them at the tick limit).

## Quick start

```bash
npm install
npm test        # engine determinism, replay, fairness, sandbox-forfeit
npm run demo    # play the reference bots against each other and print results
```

Example (`npm run demo`):

```
economy  vs idle     -> economy  (tick_limit, scores=12000:0)
rush     vs idle     -> rush     (spawn_destroyed, ticks=71)
rush     vs economy  -> rush     (spawn_destroyed, ticks=81, scores=910:840)
```

## Write a bot

A bot is one file exporting `loop(state, api)`. Read [`src/engine/bot-api.d.ts`](src/engine/bot-api.d.ts)
for the full contract and [`src/bots/`](src/bots) for working examples (`economy`, `rush`,
`random`, `idle`). Determinism rules: no clock, no randomness, no I/O — use only `state`.

```js
export function loop(state, api) {
  const { me, sources } = state;
  if (me.spawn.energy >= me.costs.creep) api.spawnCreep();
  for (const c of me.creeps) {
    const src = sources.find((s) => s.energy > 0);
    if (src) api.moveTo(c.id, src.x, src.y), api.harvest(c.id, src.id);
  }
}
```

## Fairness

- Maps are **seeded and 180°-symmetric**, so neither side gets a better board.
- The engine is **integer-only** (no floating point), so replays match bit-for-bit across
  architectures and browsers.
- Any residual first-/second-side advantage is cancelled at the **leaderboard** level: every
  pair plays **twice with swapped sides** and results are aggregated. (Leaderboard: Phase 4.)

## Roadmap

- **Phase 1 — done.** Deterministic engine, map gen, bot API, reference bots, tests.
- **Phase 2.** Run bots in a **QuickJS (WebAssembly) sandbox** with memory/stack/fuel limits;
  server-side match runner that records the per-tick command log.
- **Phase 3.** Generate bots from **OpenRouter free models** (server-held key), store a bot
  pool in the DB, hard rate limits, Markdown code extraction + dry-run before storing.
- **Phase 4.** Bradley-Terry leaderboard (Elo scale + intervals), public replay viewer (2D
  canvas), deploy to `arena.svanda.tech`, embed as a tab on the portfolio.

See [CONTRIBUTING.md](CONTRIBUTING.md) to get involved.

## License

MIT — see [LICENSE](LICENSE).
