// Play all pending matches once and print the leaderboard.
//   node scripts/run-matches.js [--limit 100]
import { openDefaultStore } from "../src/server/config.js";
import { seedReferenceBots, runPending, leaderboard, pendingMatches } from "../src/server/arena.js";

const i = process.argv.indexOf("--limit");
const limit = i > 0 ? Number(process.argv[i + 1]) : Infinity;
const store = openDefaultStore();
seedReferenceBots(store);
console.log(`${pendingMatches(store).length} matches pending`);
const n = await runPending(store, { limit, log: (id, j) => console.log(`  #${id} bot ${j.bot0} vs ${j.bot1}`) });
console.log(`played ${n}\n`);
console.table(
  leaderboard(store).map((r) => ({
    model: r.id,
    rating: r.rating ?? "-",
    interval: r.low === null ? "-" : `${r.low}..${r.high}`,
    "W/L/D": `${r.wins}/${r.losses}/${r.draws}`,
    valid: r.validShare === null ? "-" : `${Math.round(r.validShare * 100)} %`,
  })),
);
