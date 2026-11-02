# LLM Arena — notes for agents and contributors

Open-source Screeps-like PvP: free OpenRouter models each write one bot; a deterministic integer
engine runs it in a QuickJS sandbox; a Bradley-Terry leaderboard ranks the models. Plan of record:
`/Users/emperor/.claude/plans/okey-a-muzu-mit-scalable-umbrella.md` (v2, approved 2026-11-02).

## State (2026-11-02)
- Phases 1–4 implemented locally, 69 tests green (`npm test`). Local repo:
  `/Users/emperor/dev/github/EmperorKunDis/llm-arena`.
- The public GitHub repo does NOT exist yet: creating a public repo is blocked for the agent by
  the harness ("Create Public Surface"); the owner creates it with `gh repo create
  EmperorKunDis/llm-arena --public --source=. --remote=origin --push`.
- No real OpenRouter call has been made. The key once pasted into chat is COMPROMISED and must be
  rotated before Phase 0 (`npm run phase0`). Never commit or log keys.
- Deployment target: `arena.svanda.tech` on the portfolio VPS, same release pattern (see
  DEPLOY.md, ops/). The agent has no access to that VPS (keys live only in GitHub Actions) nor to
  Cloudflare DNS — the owner does the one-time setup. Deploy workflow is gated by repo variable
  `ARENA_DEPLOY_ENABLED=true`.
- Embedding: the portfolio sends no CSP, so its iframe needs no frame-src change; the arena sends
  `frame-ancestors 'self' https://svanda.tech https://www.svanda.tech`.

## Hard-won lessons
- QuickJS stack limit must stay far below the host's native WASM stack. At 512 KB a deep
  recursion overflowed the HOST (RangeError) before QuickJS caught it, which would crash the runner
  and void the match instead of scoring a loss. 192 KB is safe; a regression test covers it.
- Each bot gets its own WASM module (`newQuickJSWASMModule`, ~1 ms), so a corrupted module cannot
  affect the opponent.
- "Free" = id ends with `:free` AND zero prompt/completion price. Zero price alone also matches
  music models and the `openrouter/free` router (random model → breaks the per-match model lock).
- Perfect mirror symmetry of a single match is not guaranteed (source ties, move conflicts);
  fairness comes from every pair playing twice with sides swapped. Don't re-add a
  "self-play always draws" test for non-trivial bots.
- The `random` reference bot never harvests, so it rates exactly like `idle` — expected.
- Headless Chrome has a minimum layout width of 500 px: a `--window-size=390` screenshot is a crop
  of a 500 px layout, not a mobile render. Verify at ≥ 500 px or use real device emulation.
