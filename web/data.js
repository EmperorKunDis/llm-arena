// Data access for both deployments:
//  - server mode: JSON API served by scripts/serve.js (/api/...)
//  - static mode: pre-built JSON files (GitHub Pages), marked by
//    <meta name="arena-mode" content="static"> injected at build time.
export const STATIC = document.querySelector('meta[name="arena-mode"]')?.content === "static";

const STATIC_PATHS = [
  [/^leaderboard$/, () => "api/leaderboard.json"],
  [/^models$/, () => "api/models.json"],
  [/^matches$/, () => "api/matches.json"],
  [/^matches\/(\d+)$/, (m) => `api/match/${m[1]}.json`],
  [/^bots\/(\d+)$/, (m) => `api/bot/${m[1]}.json`],
];

export function apiUrl(path) {
  if (!STATIC) return `api/${path}`;
  const [bare] = path.split("?");
  for (const [re, to] of STATIC_PATHS) {
    const m = bare.match(re);
    if (m) return to(m);
  }
  return `api/${bare}.json`;
}

export async function getJson(path, init) {
  const res = await fetch(apiUrl(path), init);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}
