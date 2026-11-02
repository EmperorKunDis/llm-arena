// Refresh and print the free-model catalog. Needs no API key and uses no quota.
//   node scripts/catalog.js
import { openDefaultStore, defaultClient } from "../src/server/config.js";
import { refreshCatalog } from "../src/server/service.js";

const store = openDefaultStore();
const res = await refreshCatalog({ store, client: defaultClient() });
if (!res.ok) {
  console.error("Catalog refresh failed:", res.kind, res.message || "");
  process.exit(1);
}
console.log(`${res.active} free models active, ${res.deactivated} newly inactive:`);
for (const m of res.models) console.log(`  ${m.id.padEnd(58)} ctx=${m.contextLength}`);
