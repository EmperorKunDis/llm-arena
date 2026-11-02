// Production entry point: HTTP server + background match worker.
//   node --env-file=.env scripts/serve.js
import { openDefaultStore, defaultClient } from "../src/server/config.js";
import { createArenaServer } from "../src/server/http.js";
import { seedReferenceBots, runPending } from "../src/server/arena.js";
import { refreshCatalog } from "../src/server/service.js";
import { createJobs } from "../src/server/jobs.js";
import { createDuels, runDuel, nextPair } from "../src/server/duel.js";
import { consume, poolDuelBuckets, quotaConfig } from "../src/server/quota.js";
import { PROMPT_VERSION } from "../src/generate/prompt.js";

const port = Number(process.env.PORT || 3400);
const host = process.env.HOST || "127.0.0.1";
const store = openDefaultStore();
const client = defaultClient();
seedReferenceBots(store);
const jobs = createJobs();
const duels = createDuels();

// Background worker: play pending matches a few at a time (each in its own
// isolated process). Never overlaps with itself.
let busy = false;
async function work() {
  if (busy) return;
  busy = true;
  try {
    const n = await runPending(store, { limit: 4 });
    if (n) console.log(`[worker] played ${n} matches`);
  } catch (e) {
    console.error("[worker]", e.message);
  } finally {
    busy = false;
  }
}

async function refresh() {
  const r = await refreshCatalog({ store, client });
  console.log(r.ok ? `[catalog] ${r.active} free models (${r.deactivated} deactivated)` : `[catalog] failed: ${r.kind}`);
}

// Automatic duels within the daily quota: two models write their bots at the
// same time (both streams visible on the site), then fight. Models that refuse
// requests are skipped for 6 hours.
let dueling = false;
const skipUntil = new Map();
async function autoDuel() {
  if (dueling || !process.env.OPENROUTER_API_KEY || store.getSetting("halt")) return;
  const pair = nextPair(store, PROMPT_VERSION, skipUntil);
  if (!pair) return;
  if (!consume(store, poolDuelBuckets(quotaConfig())).ok) return; // daily budget used up
  dueling = true;
  try {
    const { done } = await runDuel({ store, client, jobs, duels, modelA: pair[0], modelB: pair[1], source: "auto" });
    const d = await done;
    for (const s of d.result.sides) if (s.outcome === "rejected") skipUntil.set(s.model, Date.now() + 6 * 3600_000);
    console.log("[duel]", pair.join(" vs "), "->", d.result.reason, "winner", d.result.winner);
    setTimeout(work, 100);
  } catch (e) {
    console.error("[duel]", e.message);
  } finally {
    dueling = false;
  }
}

createArenaServer({ store, client, jobs, duels, onGenerated: () => setTimeout(work, 100) }).listen(port, host, () =>
  console.log(`LLM Arena on http://${host}:${port}`),
);
await refresh();
setInterval(refresh, 6 * 60 * 60 * 1000).unref();
setInterval(work, 20_000).unref();
setInterval(autoDuel, 2 * 60 * 1000).unref(); // next duel shortly after the previous one
work();
setTimeout(autoDuel, 5_000);
