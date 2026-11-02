// Top up the bot pool from OpenRouter free models within the daily quota.
//   OPENROUTER_API_KEY=... node scripts/fill-pool.js [--per-model 3]
import { openDefaultStore, defaultClient } from "../src/server/config.js";
import { refreshCatalog, fillPool } from "../src/server/service.js";
import { usage } from "../src/server/quota.js";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set. (Use a freshly rotated key with a credit limit.)");
  process.exit(1);
}
const i = process.argv.indexOf("--per-model");
const perModel = i > 0 ? Number(process.argv[i + 1]) : 3;
const store = openDefaultStore();
const client = defaultClient();
const cat = await refreshCatalog({ store, client });
if (!cat.ok) (console.error("Catalog failed:", cat.kind), process.exit(1));
const summary = await fillPool({
  store,
  client,
  perModel,
  log: (model, out) => console.log(`  ${model.padEnd(58)} ${out.outcome}${out.status ? ":" + out.status : ""}${out.kind ? " (" + out.kind + ")" : ""}`),
});
console.log("\nSummary:", summary, "\nQuota used today:", usage(store));
