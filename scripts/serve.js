// Production entry point: HTTP server + background match worker.
//   node --env-file=.env scripts/serve.js
import { openDefaultStore, defaultClient } from "../src/server/config.js";
import { createArenaServer } from "../src/server/http.js";
import { seedReferenceBots, runPending } from "../src/server/arena.js";
import { refreshCatalog } from "../src/server/service.js";

const port = Number(process.env.PORT || 3400);
const host = process.env.HOST || "127.0.0.1";
const store = openDefaultStore();
const client = defaultClient();
seedReferenceBots(store);

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

createArenaServer({ store, client, onGenerated: () => setTimeout(work, 100) }).listen(port, host, () =>
  console.log(`LLM Arena on http://${host}:${port}`),
);
await refresh();
setInterval(refresh, 6 * 60 * 60 * 1000).unref();
setInterval(work, 20_000).unref();
work();
