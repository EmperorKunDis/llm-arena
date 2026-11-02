#!/usr/bin/env bash
# One-command install/update of LLM Arena on the svanda.tech VPS:
#   curl -fsSL https://raw.githubusercontent.com/EmperorKunDis/llm-arena/main/ops/install.sh | sudo bash
#
# Safe on a shared server: it never touches the portfolio's files or service. The
# nginx site is validated with `nginx -t`; if validation fails, the arena site is
# removed again and nginx is NOT reloaded. Re-running deploys the latest main.
set -Eeuo pipefail

REPO=https://github.com/EmperorKunDis/llm-arena.git
ROOT=/var/www/llm-arena
DOMAIN=arena.svanda.tech
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
for c in git curl openssl; do command -v $c >/dev/null || die "Missing command: $c"; done
command -v node >/dev/null || die "Node.js is not installed (need >= 22.13)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node $(node -v) is too old; LLM Arena needs >= 22.13 (built-in node:sqlite)."

say "Fetching latest release"
SHA=$(git ls-remote "$REPO" refs/heads/main | cut -f1)
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "Could not resolve main on GitHub."
REL="$ROOT/releases/$SHA"
mkdir -p "$ROOT/releases"
if [[ ! -f $REL/DEPLOY_SHA ]]; then
  rm -rf "$REL" "$REL.tmp"
  git clone -q --depth 1 "$REPO" "$REL.tmp"
  (cd "$REL.tmp" && git checkout -q "$SHA" 2>/dev/null || true; npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  rm -rf "$REL.tmp/.git"
  printf '%s\n' "$SHA" > "$REL.tmp/DEPLOY_SHA"
  mv "$REL.tmp" "$REL"
fi
echo "release $SHA"

say "System setup (user, dirs, systemd unit)"
bash "$REL/ops/bootstrap-arena.sh"

ENV="$ROOT/.env.production"
if ! grep -q '^LLM_ARENA_IP_SECRET=.\+' "$ENV" 2>/dev/null; then
  say "Writing $ENV (no OpenRouter key yet — live generation stays off)"
  cat > "$ENV" <<EOF
OPENROUTER_API_KEY=
LLM_ARENA_ACCOUNT_DAILY=50
LLM_ARENA_DAILY_LIMIT=1
LLM_ARENA_GLOBAL_DAILY_LIMIT=10
LLM_ARENA_IP_SECRET=$(openssl rand -hex 32)
LLM_ARENA_TRUST_PROXY=cloudflare
EOF
  chown root:arena "$ENV"
  chmod 0640 "$ENV"
fi

NODE_BIN=$(readlink -f "$(command -v node)")
case $NODE_BIN in /root/*|/home/*) die "Node is installed in a home directory ($NODE_BIN); the service user cannot reach it. Install a system-wide Node >= 22.13.";; esac
install -d /etc/systemd/system/llm-arena.service.d
printf '[Service]\nExecStart=\nExecStart=%s scripts/serve.js\n' "$NODE_BIN" > /etc/systemd/system/llm-arena.service.d/node.conf
systemctl daemon-reload

say "Starting release"
/usr/local/sbin/llm-arena-activate "$SHA"

say "Reverse proxy for $DOMAIN"
if ! command -v nginx >/dev/null; then
  echo "nginx not found. The arena runs on http://127.0.0.1:3400 — point your proxy for $DOMAIN there."
  exit 0
fi
DUMP=$(nginx -T 2>/dev/null || true)
# Self-signed fallback (Cloudflare "Full" does not validate the origin certificate).
FB_CERT=/etc/ssl/llm-arena/origin.pem
FB_KEY=/etc/ssl/llm-arena/origin.key
if [[ ! -f $FB_CERT ]]; then
  install -d -m 0750 /etc/ssl/llm-arena
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$DOMAIN" -keyout "$FB_KEY" -out "$FB_CERT" >/dev/null 2>&1
  chmod 0600 "$FB_KEY"
fi
command -v python3 >/dev/null || die "python3 is required to mirror the portfolio's nginx setup."
GEN=$(mktemp)
IFS=$'\t' read -r SITE LINK CHECK_IP CERT < <(python3 "$REL/ops/nginx-site.py" "$REL/ops/nginx-arena.conf" "$GEN" "$FB_CERT" "$FB_KEY" <<<"$DUMP")
echo "site    : $SITE ${LINK:+(link $LINK)}"
echo "cert    : $CERT"
echo "listen  : $(grep -E '^\s*listen' "$GEN" | tr -s ' ' | tr '\n' ' ')"

# Remove arena sites left by earlier runs (kept as backups for revert).
BACKUP=$(mktemp -d)
for old in /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN /etc/nginx/conf.d/$DOMAIN.conf "$SITE" ${LINK:+"$LINK"}; do
  if [[ -e $old || -L $old ]]; then mkdir -p "$BACKUP$(dirname "$old")"; mv "$old" "$BACKUP$old"; fi
done
install -m 0644 "$GEN" "$SITE"
[[ -n $LINK ]] && ln -sfn "$SITE" "$LINK"

if nginx -t 2>/tmp/llm-arena-nginx-test.log; then
  systemctl reload nginx
  echo "nginx reloaded."
else
  cat /tmp/llm-arena-nginx-test.log >&2
  rm -f "$SITE"; [[ -n $LINK ]] && rm -f "$LINK"
  (cd "$BACKUP" && find . \( -type f -o -type l \) | while read -r f; do mv "$f" "/${f#./}"; done)
  die "nginx -t failed; the arena site was reverted and nginx was NOT reloaded (portfolio untouched)."
fi
sleep 1

say "Checking"
LOCAL=$(curl -fsS --max-time 5 http://127.0.0.1:3400/api/health || true)
VIA_NGINX=$(curl -fsSk --max-time 5 --resolve "$DOMAIN:443:$CHECK_IP" "https://$DOMAIN/api/health" || true)
echo "service : $LOCAL"
echo "nginx   : $VIA_NGINX"
if [[ $VIA_NGINX != *"$SHA"* ]]; then
  echo; echo "---- diagnostics (paste this to the developer) ----"
  nginx -T 2>/dev/null | grep -nE "# configuration file|^\s*include|^\s*listen|^\s*server_name" | head -80
  echo "---------------------------------------------------"
  die "nginx does not route $DOMAIN to the arena yet."
fi
say "Done — https://$DOMAIN (add OPENROUTER_API_KEY to $ENV and 'systemctl restart llm-arena' to enable live generation)"
