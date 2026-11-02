// Phase 0 probe: can free models write a bot that loads and runs?
// Asks up to N models for ONE bot each and reports the valid-code share.
// Writes to its own database so the real pool stays clean.
//   OPENROUTER_API_KEY=... node scripts/phase0.js [--models 8]
import { openStore } from "../src/server/store.js";
import { defaultClient } from "../src/server/config.js";
import { refreshCatalog } from "../src/server/service.js";
import { generateBot } from "../src/generate/pipeline.js";
import { consume, poolBuckets, quotaConfig, usage } from "../src/server/quota.js";
import { mkdirSync } from "node:fs";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set. (Use a freshly rotated key with a credit limit.)");
  process.exit(1);
}
const i = process.argv.indexOf("--models");
const limit = i > 0 ? Number(process.argv[i + 1]) : 8;
mkdirSync("data", { recursive: true });
const store = openStore("data/phase0.sqlite");
const client = defaultClient();
const cat = await refreshCatalog({ store, client });
if (!cat.ok) (console.error("Catalog failed:", cat.kind), process.exit(1));

const rows = [];
for (const m of cat.models.slice(0, limit)) {
  if (!consume(store, poolBuckets(quotaConfig())).ok) {
    console.log("Daily quota reached, stopping.");
    break;
  }
  const out = await generateBot({ modelId: m.id, client, store, source: "pool" });
  const bot = out.botId ? store.getBot(out.botId) : null;
  rows.push({ model: m.id, outcome: out.outcome, status: out.status || "-", kind: out.kind || "", normalized: bot?.normalized || "", chars: bot?.code?.length || 0 });
  console.log(rows.at(-1));
  if (out.outcome === "stop" || out.outcome === "halted") break;
  await new Promise((r) => setTimeout(r, 3500));
}
const scored = rows.filter((r) => r.outcome === "stored");
const valid = scored.filter((r) => r.status === "valid").length;
console.table(rows);
console.log(`Valid bots: ${valid}/${scored.length} (${scored.length ? Math.round((100 * valid) / scored.length) : 0} %), infrastructure errors: ${rows.length - scored.length}`);
console.log("Quota used today:", usage(store));
