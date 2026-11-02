// SQLite store (Node's built-in node:sqlite — zero dependencies, easy self-hosting).
// Holds the free-model catalog history, the bot pool, generation attempts,
// quota counters and matches.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT,
  context_length INTEGER,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  model_actual TEXT,
  provider TEXT,
  prompt_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('pool','live','reference')),
  status TEXT NOT NULL CHECK (status IN ('valid','invalid')),
  error_kind TEXT,
  error_message TEXT,
  normalized TEXT,
  code TEXT,
  code_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (model_id, code_hash)
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  source TEXT NOT NULL,
  outcome TEXT NOT NULL,
  kind TEXT,
  message TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quota (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, scope, key)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seed INTEGER NOT NULL,
  bot0 INTEGER NOT NULL,
  bot1 INTEGER NOT NULL,
  pair_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('done','invalid','infra_error')),
  winner INTEGER,
  reason TEXT,
  forfeit INTEGER,
  errors TEXT,
  scores TEXT,
  ticks INTEGER,
  record_gz BLOB,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bots_model ON bots (model_id, prompt_version, status);
CREATE INDEX IF NOT EXISTS matches_bots ON matches (bot0, bot1);
`;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  return {
    db,
    tx,

    // ---- catalog ----
    syncModels(models, now = new Date().toISOString()) {
      return tx(() => {
        const ids = new Set(models.map((m) => m.id));
        const up = db.prepare(
          `INSERT INTO models (id, name, context_length, first_seen, last_seen, active)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, context_length = excluded.context_length,
             last_seen = excluded.last_seen, active = 1`,
        );
        for (const m of models) up.run(m.id, m.name, m.contextLength, now, now);
        const all = db.prepare("SELECT id FROM models WHERE active = 1").all();
        const off = db.prepare("UPDATE models SET active = 0 WHERE id = ?");
        let deactivated = 0;
        for (const r of all) if (!ids.has(r.id)) (off.run(r.id), deactivated++);
        return { active: models.length, deactivated };
      });
    },
    listModels({ activeOnly = false } = {}) {
      return db
        .prepare(`SELECT * FROM models ${activeOnly ? "WHERE active = 1" : ""} ORDER BY id`)
        .all();
    },

    // ---- bots ----
    insertBot(bot, now = new Date().toISOString()) {
      const hash = bot.code ? sha256(bot.code) : null;
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO bots (model_id, model_actual, provider, prompt_version, source, status,
             error_kind, error_message, normalized, code, code_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bot.modelId,
          bot.modelActual ?? null,
          bot.provider ?? null,
          bot.promptVersion,
          bot.source,
          bot.status,
          bot.errorKind ?? null,
          bot.errorMessage ?? null,
          bot.normalized ?? null,
          bot.code ?? null,
          hash,
          now,
        );
      return res.changes ? Number(res.lastInsertRowid) : null; // null = duplicate code
    },
    getBot(id) {
      return db.prepare("SELECT * FROM bots WHERE id = ?").get(id);
    },
    listBots({ status, promptVersion } = {}) {
      const where = [];
      const args = [];
      if (status) where.push("status = ?"), args.push(status);
      if (promptVersion) where.push("prompt_version = ?"), args.push(promptVersion);
      return db
        .prepare(`SELECT * FROM bots ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`)
        .all(...args);
    },
    countBots(modelId, promptVersion) {
      return db
        .prepare("SELECT COUNT(*) AS n FROM bots WHERE model_id = ? AND prompt_version = ?")
        .get(modelId, promptVersion).n;
    },

    // ---- attempts (calls that produced no bot, e.g. infrastructure errors) ----
    logAttempt(a, now = new Date().toISOString()) {
      db.prepare(
        "INSERT INTO attempts (model_id, source, outcome, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(a.modelId, a.source, a.outcome, a.kind ?? null, a.message ?? null, now);
    },
    listAttempts() {
      return db.prepare("SELECT * FROM attempts ORDER BY id").all();
    },

    // ---- settings (global halt etc.) ----
    getSetting(key) {
      return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
    },
    setSetting(key, value) {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    },

    // ---- matches ----
    insertMatch(m, now = new Date().toISOString()) {
      const res = db
        .prepare(
          `INSERT INTO matches (seed, bot0, bot1, pair_key, status, winner, reason, forfeit, errors, scores, ticks, record_gz, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.seed,
          m.bot0,
          m.bot1,
          m.pairKey ?? null,
          m.status,
          m.winner ?? null,
          m.reason ?? null,
          m.forfeit ?? null,
          JSON.stringify(m.errors ?? null),
          JSON.stringify(m.scores ?? null),
          m.ticks ?? null,
          m.recordGz ?? null,
          now,
        );
      return Number(res.lastInsertRowid);
    },
    getMatch(id) {
      return db.prepare("SELECT * FROM matches WHERE id = ?").get(id);
    },
    listMatches({ status } = {}) {
      return db
        .prepare(`SELECT id, seed, bot0, bot1, pair_key, status, winner, reason, forfeit, errors, scores, ticks, created_at
                  FROM matches ${status ? "WHERE status = ?" : ""} ORDER BY id`)
        .all(...(status ? [status] : []));
    },

    close() {
      db.close();
    },
  };
}
