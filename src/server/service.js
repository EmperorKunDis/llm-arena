// High-level generation services used by the API routes and CLI scripts.

import { generateBot } from "../generate/pipeline.js";
import { PROMPT_VERSION } from "../generate/prompt.js";
import { filterFreeModels } from "../openrouter/catalog.js";
import { consume, hashIp, liveBuckets, poolBuckets, quotaConfig } from "./quota.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Refresh the free-model catalog from OpenRouter (no generation quota used). */
export async function refreshCatalog({ store, client }) {
  const res = await client.listModels();
  if (!res.ok) return res;
  const free = filterFreeModels(res.models);
  return { ok: true, ...store.syncModels(free), models: free };
}

/** Validate a live request and reserve its quota (fast, synchronous). */
export function reserveLive({ store, ip, modelId, cfg = quotaConfig() }) {
  const model = store.listModels({ activeOnly: true }).find((m) => m.id === modelId);
  if (!model) return { ok: false, error: "unknown_model" };
  if (store.getSetting("halt")) return { ok: false, error: "halted" };
  let ipHash;
  try {
    ipHash = hashIp(ip, cfg.ipSecret);
  } catch {
    return { ok: false, error: "not_configured" };
  }
  const q = consume(store, liveBuckets(cfg, ipHash));
  if (!q.ok) return { ok: false, error: "quota", scope: q.scope };
  return { ok: true };
}

/** A visitor pressed "generate a new bot" (synchronous variant, used by tests/CLI). */
export async function generateLive({ store, client, ip, modelId, cfg = quotaConfig() }) {
  const r = reserveLive({ store, ip, modelId, cfg });
  if (!r.ok) return r;
  const out = await generateBot({ modelId, client, store, source: "live" });
  return { ok: out.stored, ...out };
}

/**
 * Top up the bot pool: up to `perModel` bots per active model and prompt
 * version, within the pool share of the daily account budget.
 */
export async function fillPool({
  store,
  client,
  cfg = quotaConfig(),
  perModel = 3,
  sleepMs = 3500, // OpenRouter free tier: 20 requests/minute
  maxInfraStreak = 3,
  log = () => {},
}) {
  const summary = { calls: 0, stored: 0, valid: 0, invalid: 0, infra: 0, stoppedBy: null };
  let infraStreak = 0;
  for (const m of store.listModels({ activeOnly: true })) {
    while (store.countBots(m.id, PROMPT_VERSION) < perModel) {
      if (store.getSetting("halt")) return { ...summary, stoppedBy: `halt:${store.getSetting("halt")}` };
      const q = consume(store, poolBuckets(cfg));
      if (!q.ok) return { ...summary, stoppedBy: "quota" };
      if (summary.calls > 0 && sleepMs) await sleep(sleepMs);
      summary.calls++;
      const out = await generateBot({ modelId: m.id, client, store, source: "pool" });
      log(m.id, out);
      if (out.outcome === "infra" || out.outcome === "rejected") {
        summary.infra++;
        if (out.outcome === "rejected") break; // model refuses the request; skip it
        if (++infraStreak >= maxInfraStreak) return { ...summary, stoppedBy: "infra_streak" };
        continue;
      }
      infraStreak = 0;
      if (out.outcome === "halted") return { ...summary, stoppedBy: `halt:${out.kind}` };
      if (out.outcome === "stop") return { ...summary, stoppedBy: `halt:${out.kind}` };
      if (out.stored) {
        summary.stored++;
        summary[out.status]++;
      } else if (out.outcome === "duplicate") {
        break; // model keeps writing the same bot; move on
      }
    }
  }
  return summary;
}
