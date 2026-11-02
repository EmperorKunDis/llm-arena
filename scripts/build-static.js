// Build the static site (GitHub Pages): web pages + engine modules + pre-rendered
// JSON for every API view. No server needed; replays run in the browser.
//   node scripts/build-static.js [--out dist] [--domain arena.svanda.tech]
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDefaultStore } from "../src/server/config.js";
import { seedReferenceBots } from "../src/server/arena.js";
import { leaderboardView, matchesView, matchDetailView, publicBot } from "../src/server/views.js";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT = arg("--out", "dist");
const DOMAIN = arg("--domain", "arena.svanda.tech");

const store = openDefaultStore();
seedReferenceBots(store);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "api/match"), { recursive: true });
mkdirSync(join(OUT, "api/bot"), { recursive: true });
cpSync("web", OUT, { recursive: true });
cpSync("src/engine", join(OUT, "engine"), { recursive: true });

// Mark pages as static so the frontend reads the pre-built JSON files.
for (const f of readdirSync(OUT).filter((f) => f.endsWith(".html"))) {
  const p = join(OUT, f);
  writeFileSync(
    p,
    readFileSync(p, "utf8").replace("<head>", '<head>\n    <meta name="arena-mode" content="static" />'),
  );
}

const write = (rel, data) => writeFileSync(join(OUT, rel), JSON.stringify(data));
write("api/leaderboard.json", { ...leaderboardView(store), builtAt: new Date().toISOString() });
write("api/models.json", {
  models: store.listModels({ activeOnly: true }).map((m) => ({ id: m.id, name: m.name })),
  live: {
    enabled: false,
    note: "New bots are generated automatically several times a day within the free OpenRouter quota (50 requests/day).",
  },
});
write("api/matches.json", matchesView(store, 200));

let matches = 0;
for (const m of store.listMatches({ status: "done" })) {
  const detail = matchDetailView(store, m.id);
  if (detail) (write(`api/match/${m.id}.json`, detail), matches++);
}
let bots = 0;
for (const b of store.listBots()) (write(`api/bot/${b.id}.json`, publicBot(b, true)), bots++);

writeFileSync(join(OUT, ".nojekyll"), "");
if (DOMAIN) writeFileSync(join(OUT, "CNAME"), `${DOMAIN}\n`);
console.log(`static site in ${OUT}/: ${matches} matches, ${bots} bots, domain ${DOMAIN || "-"}`);
