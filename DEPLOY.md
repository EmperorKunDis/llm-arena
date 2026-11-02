# Deploying LLM Arena to arena.svanda.tech

Same VPS and the same release pattern as the svanda.tech portfolio: immutable releases in
`/var/www/llm-arena/releases/<sha>`, a `current` symlink, systemd, health check with automatic
rollback. The arena is a separate service on `127.0.0.1:3400`.

## One-time setup (owner)

1. **Rotate the OpenRouter key** (the old one was exposed) and set a credit limit on the new key.
2. **DNS:** in Cloudflare add `arena.svanda.tech` → the portfolio VPS (proxied, like `svanda.tech`).
3. **Server** (as root, from a checkout or an unpacked release):
   ```bash
   sudo bash ops/bootstrap-arena.sh            # user, dirs, systemd unit, sudoers for 'deploy'
   sudo cp ops/nginx-arena.conf /etc/nginx/sites-available/arena.svanda.tech
   sudo ln -s /etc/nginx/sites-available/arena.svanda.tech /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo nano /var/www/llm-arena/.env.production   # values from .env.example; LLM_ARENA_TRUST_PROXY=cloudflare
   ```
   Requires Node ≥ 22.13 on the server (built-in `node:sqlite`). `llm-arena-activate` refuses to run otherwise.
4. **GitHub** (repo `EmperorKunDis/llm-arena` → Settings):
   - Secrets: `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS` (same values as in `macos-portfolio`).
   - Variables: `VPS_HOST`, `VPS_PORT`, `VPS_USER` (same as the portfolio), `ARENA_DEPLOY_ENABLED=true`.
   - Environment `production` (optionally with required reviewers).

## Every deploy

Push to `main` → **CI** runs the tests → **Deploy** builds the release (tests again, prunes dev
dependencies), uploads it and runs `llm-arena-activate <sha>`, which switches the symlink,
restarts the service and waits for `/api/health` to report the new sha — or rolls back.

## Verify

```bash
curl -s https://arena.svanda.tech/api/health        # {"status":"ok","sha":"<deployed sha>"}
curl -sI https://arena.svanda.tech/ | grep -i frame-ancestors
```

## First data

```bash
# on the server, as the arena user, inside /var/www/llm-arena/current
node --env-file=/var/www/llm-arena/.env.production scripts/phase0.js --models 8   # probe free models
node --env-file=/var/www/llm-arena/.env.production scripts/fill-pool.js           # fills over days (50 req/day)
```
The running service plays new pool bots automatically.
