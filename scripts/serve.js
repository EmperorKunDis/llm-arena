// Production entry point: HTTP server + background match worker.
//   node --env-file=.env scripts/serve.js
import { openDefaultStore, defaultClient } from "../src/server/config.js";
import { createArenaServer } from "../src/server/http.js";
import { seedReferenceBots, runPending } from "../src/server/arena.js";
import { refreshCatalog, fillPool } from "../src/server/service.js";
import { createJobs } from "../src/server/jobs.js";

const port = Number(process.env.PORT || 3400);
const host = process.env.HOST || "127.0.0.1";
const store = openDefaultStore();
const client = defaultClient();
seedReferenceBots(store);
const jobs = createJobs();

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

// Background pool filling within the daily quota. Every call is registered as a
// job, so visitors watch the models write their bots live on the site.
let filling = false;
async function fill() {
  if (filling || !process.env.OPENROUTER_API_KEY) return;
  filling = true;
  try {
    const s = await fillPool({
      store,
      client,
      perModel: 3,
      track: (modelId) => {
        const job = jobs.start({ modelId, source: "pool" });
        return {
          onDelta: jobs.onDelta(job),
          done: (out) => {
            jobs.finish(job, { ok: out.stored, ...out });
            if (out.stored) setTimeout(work, 100);
          },
        };
      },
    });
    if (s.calls) console.log("[pool]", JSON.stringify(s));
  } catch (e) {
    console.error("[pool]", e.message);
  } finally {
    filling = false;
  }
}

createArenaServer({ store, client, jobs, onGenerated: () => setTimeout(work, 100) }).listen(port, host, () =>
  console.log(`LLM Arena on http://${host}:${port}`),
);
await refresh();
setInterval(refresh, 6 * 60 * 60 * 1000).unref();
setInterval(work, 20_000).unref();
setInterval(fill, 15 * 60 * 1000).unref();
work();
setTimeout(fill, 5_000);
