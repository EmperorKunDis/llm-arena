#!/usr/bin/env bash
# One-time server setup for LLM Arena on the existing portfolio VPS. Run as root
# from an unpacked release:  sudo bash ops/bootstrap-arena.sh
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 77; }
src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

HAVE_DEPLOY=0; id deploy >/dev/null 2>&1 && HAVE_DEPLOY=1
id arena >/dev/null 2>&1 || useradd --system --home-dir /var/lib/llm-arena --shell /usr/sbin/nologin arena

if [[ $HAVE_DEPLOY == 1 ]]; then
  install -d -o deploy -g arena -m 2775 /var/www/llm-arena/releases
else
  echo "No 'deploy' user: CI auto-deploy sudoers is skipped (re-run ops/install.sh to update)."
  install -d -o root -g arena -m 2775 /var/www/llm-arena/releases
fi
install -d -o arena -g arena -m 0750 /var/lib/llm-arena /var/log/llm-arena
if [[ ! -f /var/www/llm-arena/.env.production ]]; then
  install -o root -g arena -m 0640 /dev/null /var/www/llm-arena/.env.production
  echo "Created empty /var/www/llm-arena/.env.production — fill it from .env.example."
fi

install -o root -g root -m 0755 "$src/llm-arena-activate" /usr/local/sbin/llm-arena-activate
systemd-analyze verify "$src/llm-arena.service" || true
install -o root -g root -m 0644 "$src/llm-arena.service" /etc/systemd/system/llm-arena.service
if [[ $HAVE_DEPLOY == 1 ]]; then
  tmp=$(mktemp /etc/sudoers.d/llm-arena.XXXXXX)
  install -o root -g root -m 0440 "$src/llm-arena-deploy.sudoers" "$tmp"
  visudo -cf "$tmp" && mv -f "$tmp" /etc/sudoers.d/llm-arena-deploy
fi
systemctl daemon-reload
systemctl enable llm-arena.service
echo "Bootstrap done. Next: reverse proxy for arena.svanda.tech -> 127.0.0.1:3400 (see ops/nginx-arena.conf)."
