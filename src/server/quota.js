// Quota counters in the database (atomic, survive restarts, work across
// processes) — never in process memory. The OpenRouter free limit is per
// ACCOUNT (50/day without credits), so one budget is shared by:
//   - pool filling   : may use the account budget EXCEPT the live reserve
//   - live generation: per-IP limit + global live cap, may use the reserve
// Visitor IPs are stored only as an HMAC (secret + UTC day), never in clear.

import { createHmac } from "node:crypto";

export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

export function quotaConfig(env = process.env) {
  const int = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 0 && v !== "" && v != null ? Number(v) : d);
  const accountDaily = int(env.LLM_ARENA_ACCOUNT_DAILY, 50);
  const liveGlobal = Math.min(int(env.LLM_ARENA_GLOBAL_DAILY_LIMIT, 10), accountDaily);
  return {
    accountDaily,
    liveGlobal,
    livePerIp: int(env.LLM_ARENA_DAILY_LIMIT, 1),
    poolDaily: accountDaily - liveGlobal, // the rest is reserved for live
    ipSecret: env.LLM_ARENA_IP_SECRET || null,
  };
}

export function hashIp(ip, secret, day = utcDay()) {
  if (!secret) throw Object.assign(new Error("LLM_ARENA_IP_SECRET is not configured."), { code: "config" });
  return createHmac("sha256", secret).update(`${day}|${ip}`).digest("hex").slice(0, 32);
}

/**
 * Atomically consume from every bucket, or from none.
 * buckets: [{ scope, key, limit, amount = 1 }]. Returns { ok:true } or { ok:false, scope }.
 */
export function consume(store, buckets, day = utcDay()) {
  return store.tx(() => {
    const get = store.db.prepare("SELECT count FROM quota WHERE day = ? AND scope = ? AND key = ?");
    for (const b of buckets) {
      const used = get.get(day, b.scope, b.key)?.count ?? 0;
      const amount = b.amount ?? 1;
      if (b.limit <= 0 || used + amount > b.limit) return { ok: false, scope: b.scope, used, limit: b.limit };
    }
    const inc = store.db.prepare(
      `INSERT INTO quota (day, scope, key, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, scope, key) DO UPDATE SET count = count + excluded.count`,
    );
    for (const b of buckets) inc.run(day, b.scope, b.key, b.amount ?? 1);
    return { ok: true };
  });
}

export const poolBuckets = (cfg) => [{ scope: "account", key: "*", limit: cfg.poolDaily }];

export const liveBuckets = (cfg, ipHash) => [
  { scope: "live_ip", key: ipHash, limit: cfg.livePerIp },
  { scope: "live_global", key: "*", limit: cfg.liveGlobal },
  { scope: "account", key: "*", limit: cfg.accountDaily },
];

// A duel = two model calls. Per-IP limit counts duels; the shared budgets count requests.
export const duelBuckets = (cfg, ipHash) => [
  { scope: "live_ip", key: ipHash, limit: cfg.livePerIp, amount: 1 },
  { scope: "live_global", key: "*", limit: cfg.liveGlobal, amount: 2 },
  { scope: "account", key: "*", limit: cfg.accountDaily, amount: 2 },
];
export const poolDuelBuckets = (cfg) => [{ scope: "account", key: "*", limit: cfg.poolDaily, amount: 2 }];

export function usage(store, day = utcDay()) {
  const rows = store.db.prepare("SELECT scope, SUM(count) AS n FROM quota WHERE day = ? GROUP BY scope").all(day);
  return Object.fromEntries(rows.map((r) => [r.scope, r.n]));
}
