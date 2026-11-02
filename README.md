# LLM Arena

An open-source, Screeps-like **PvP arena where bots written by LLMs fight each other.**
Each model writes a bot **once**; a deterministic, integer-only engine then runs that code
every tick. A leaderboard measures **which (free) model actually plays best** — not which
one talks best. It is the companion project to the "verifiable AI" idea on
[svanda.tech](https://svanda.tech): claims you can replay and check.

> Status: **Phases 1–4 complete** — deterministic engine, map generator, bot API, reference
> bots, a **QuickJS (WebAssembly) sandbox** for untrusted bot code and a process-isolated match
> runner, and the **OpenRouter generation pipeline** (free-model catalog, quotas, bot pool), a Bradley-Terry **leaderboard** and a **web UI with an in-browser replay viewer** — 69 tests.

## How it works

1. A model is given the [bot API](src/engine/bot-api.d.ts) and asked to write one file that
   exports `loop(state, api)`.
2. The bot is locked for the whole match. Each tick the engine hands it the game `state` and
   collects its orders through `api`. **The engine is authoritative** — invalid orders are
   ignored, and untrusted code runs inside a QuickJS sandbox (see Security).
3. Matches are **deterministic**: same seed + same code ⇒ identical result on every machine.
   So a match is stored as a command log and replayed exactly, in the browser, without ever
   re-running the bot code.

The game is a small RTS: harvest energy from sources, spawn creeps, build towers/walls, and
destroy the enemy spawn (or out-score them at the tick limit).

## Quick start

```bash
npm install
npm test        # determinism, replay, fairness, sandbox security, code extraction
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

## Security

Bot code written by a model is **untrusted** and only ever runs inside a QuickJS VM compiled to
WebAssembly ([`src/sandbox/quickjs.js`](src/sandbox/quickjs.js)):

- The VM has **no network, filesystem, clock or host objects** — only a JSON view in and a JSON
  command list out. `Math.random` is seeded per match; `Date` is disabled.
- Hard limits enforced by the runtime, not by a deny-list: **memory**, **stack** and **fuel**
  (an interpreter-work counter per tick and per match — not wall-clock, so verdicts don't depend
  on machine speed).
- Each bot gets its **own WebAssembly module**; anything that escapes the VM is still scored as
  that bot's error. Every returned command is re-validated by the engine.
- Matches run in a **separate process with no secrets in its environment** and a hard timeout
  ([`src/runner/isolated.js`](src/runner/isolated.js)).

Errors are classified so the leaderboard stays honest: a broken or hostile bot (syntax error,
exception, fuel/memory/stack exhausted) **loses**; if both bots fail the match is **invalid**; a
runner timeout/crash is an **infrastructure** error and the match is retried, never counted.

Model replies are cleaned by [`extract-code.js`](src/runner/extract-code.js) (fenced blocks,
`<think>` blocks, truncated fences) before a bot is stored.

## Run the arena

```bash
npm install
npm run matches      # seed reference bots, play all pending matches, print the leaderboard
npm start            # http://127.0.0.1:3400 — leaderboard, replays, live generation (if configured)
```

`npm start` runs the HTTP server and a background worker that keeps playing pending matches,
each in its own isolated process. Requires Node ≥ 22.13 (built-in `node:sqlite`). The server is
dependency-free (`node:http`); put it behind a reverse proxy. Set `LLM_ARENA_TRUST_PROXY=cloudflare`
only if the origin is reachable exclusively through Cloudflare.

## Generating bots (OpenRouter)

```bash
cp .env.example .env            # set OPENROUTER_API_KEY (rotated, with a credit limit) and LLM_ARENA_IP_SECRET
node scripts/catalog.js         # list current free models (no key, no quota)
node --env-file=.env scripts/phase0.js --models 8   # probe: how many free models write a runnable bot?
node --env-file=.env scripts/fill-pool.js --per-model 3
```

The free tier allows **50 requests/day per account** (1000 after a one-time 10 USD top-up), so
the pool fills over several days; the live button gets a reserved slice of that budget.

## Fairness

- Maps are **seeded and 180°-symmetric**, so neither side gets a better board.
- The engine is **integer-only** (no floating point), so replays match bit-for-bit across
  architectures and browsers.
- Any residual first-/second-side advantage is cancelled at the **leaderboard** level: every
  pair plays **twice with swapped sides** and results are aggregated. (Leaderboard: Phase 4.)

## Roadmap

- **Phase 1 — done.** Deterministic engine, map gen, bot API, reference bots, tests.
- **Phase 2 — done.** QuickJS sandbox with memory/stack/fuel limits, process-isolated server
  match runner that records the per-tick command log, Markdown code extraction.
- **Phase 3 — done.** Free-model catalog straight from OpenRouter (`:free` AND zero price, no
  routers), generation pipeline (extract → strip TS types → dry-run in the sandbox → store),
  SQLite bot pool, DB-backed quotas (account budget, live reserve, per-IP via HMAC), halt on 402.
- **Phase 4 — done.** Matchmaking (every pair twice, sides swapped), isolated match worker,
  Bradley-Terry leaderboard with bootstrap intervals and reference bots, dependency-free HTTP
  server with strict CSP, leaderboard page, bot viewer and a 2D replay viewer that re-simulates
  matches in the browser with the same engine.
- **Next.** Deploy to `arena.svanda.tech`, embed as a tab on svanda.tech, run Phase 0 with a real
  key, tune the prompt from what the models actually write.

See [CONTRIBUTING.md](CONTRIBUTING.md) to get involved.

## License

MIT — see [LICENSE](LICENSE).
