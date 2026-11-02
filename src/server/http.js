// Dependency-free HTTP server: JSON API + static frontend. The browser imports
// the engine straight from /engine/*, so the replay viewer runs the exact same
// deterministic code as the server — and never executes bot code.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeRecord, leaderboard, PROVISIONAL_GAMES } from "./arena.js";
import { generateLive } from "./service.js";
import { quotaConfig, usage } from "./quota.js";
import { PROMPT_VERSION } from "../generate/prompt.js";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STATIC = { "/": resolve(ROOT, "web"), "/engine/": resolve(ROOT, "src/engine") };
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

// Release revision written by the deploy (mirrors the portfolio's /api/health).
let DEPLOY_SHA = null;
try {
  DEPLOY_SHA = readFileSync(resolve(ROOT, "DEPLOY_SHA"), "utf8").trim() || null;
} catch {
  /* local/dev run */
}

const FRAME_ANCESTORS = "'self' https://svanda.tech https://www.svanda.tech";
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${FRAME_ANCESTORS}`,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const send = (res, status, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": isBuf ? "application/octet-stream" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(isBuf || typeof body === "string" ? body : JSON.stringify(body));
};

async function readJson(req, limit = 2048) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function clientIp(req, env) {
  // Only trust the Cloudflare header when explicitly configured (origin must be
  // reachable through Cloudflare only, or the header can be spoofed).
  if (env.LLM_ARENA_TRUST_PROXY === "cloudflare" && req.headers["cf-connecting-ip"])
    return String(req.headers["cf-connecting-ip"]);
  return req.socket.remoteAddress || "unknown";
}

async function serveStatic(res, pathname) {
  for (const [prefix, dir] of Object.entries(STATIC).sort((a, b) => b[0].length - a[0].length)) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(dir, decodeURIComponent(rel)));
    if (file !== dir && !file.startsWith(dir + sep)) return send(res, 403, { error: "forbidden" });
    try {
      const data = await readFile(file);
      const type = TYPES[extname(file)] || "application/octet-stream";
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": type,
        "Cache-Control": type.startsWith("text/html") ? "no-cache" : "public, max-age=300",
      });
      return res.end(data);
    } catch {
      /* try next prefix */
    }
  }
  return send(res, 404, { error: "not_found" });
}

const publicBot = (b, withCode = false) =>
  b && {
    id: b.id,
    model: b.model_id,
    modelActual: b.model_actual,
    provider: b.provider,
    promptVersion: b.prompt_version,
    source: b.source,
    status: b.status,
    errorKind: b.error_kind,
    normalized: b.normalized,
    createdAt: b.created_at,
    ...(withCode ? { code: b.code, errorMessage: b.error_message } : {}),
  };

export function createArenaServer({ store, client, env = process.env, onGenerated = () => {} }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/api/health") return send(res, 200, { status: "ok", sha: DEPLOY_SHA });

      if (req.method === "GET" && p === "/api/leaderboard")
        return send(
          res,
          200,
          { promptVersion: PROMPT_VERSION, provisionalGames: PROVISIONAL_GAMES, rows: leaderboard(store) },
          { "Cache-Control": "public, max-age=30" },
        );

      if (req.method === "GET" && p === "/api/models") {
        const cfg = quotaConfig(env);
        return send(res, 200, {
          models: store.listModels({ activeOnly: true }).map((m) => ({ id: m.id, name: m.name })),
          live: {
            enabled: Boolean(env.OPENROUTER_API_KEY && cfg.ipSecret) && !store.getSetting("halt"),
            perIpDaily: cfg.livePerIp,
            globalDaily: cfg.liveGlobal,
            usedToday: usage(store).live_global || 0,
          },
        });
      }

      if (req.method === "GET" && p === "/api/matches") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 200);
        const bots = new Map(store.listBots().map((b) => [b.id, b]));
        const rows = store
          .listMatches({ status: "done" })
          .slice(-limit)
          .reverse()
          .map((m) => ({
            id: m.id,
            bot0: { id: m.bot0, model: bots.get(m.bot0)?.model_id },
            bot1: { id: m.bot1, model: bots.get(m.bot1)?.model_id },
            winner: m.winner,
            reason: m.reason,
            forfeit: m.forfeit,
            scores: JSON.parse(m.scores || "null"),
            ticks: m.ticks,
            createdAt: m.created_at,
          }));
        return send(res, 200, { matches: rows }, { "Cache-Control": "public, max-age=15" });
      }

      let mm = p.match(/^\/api\/matches\/(\d+)$/);
      if (req.method === "GET" && mm) {
        const m = store.getMatch(Number(mm[1]));
        if (!m || m.status !== "done") return send(res, 404, { error: "not_found" });
        return send(
          res,
          200,
          {
            id: m.id,
            seed: m.seed,
            winner: m.winner,
            reason: m.reason,
            forfeit: m.forfeit,
            errors: JSON.parse(m.errors || "null"),
            scores: JSON.parse(m.scores || "null"),
            ticks: m.ticks,
            bots: [publicBot(store.getBot(m.bot0)), publicBot(store.getBot(m.bot1))],
            record: decodeRecord(m),
          },
          { "Cache-Control": "public, max-age=3600" },
        );
      }

      mm = p.match(/^\/api\/bots\/(\d+)$/);
      if (req.method === "GET" && mm) {
        const b = store.getBot(Number(mm[1]));
        if (!b) return send(res, 404, { error: "not_found" });
        return send(res, 200, publicBot(b, true));
      }

      if (req.method === "POST" && p === "/api/generate") {
        const body = await readJson(req);
        if (typeof body.modelId !== "string") return send(res, 400, { error: "modelId required" });
        if (!env.OPENROUTER_API_KEY) return send(res, 503, { error: "not_configured" });
        const out = await generateLive({
          store,
          client,
          ip: clientIp(req, env),
          modelId: body.modelId,
          cfg: quotaConfig(env),
        });
        if (out.ok) onGenerated(out);
        const status = out.ok
          ? 201
          : out.error === "quota"
            ? 429
            : out.error === "unknown_model"
              ? 400
              : out.error === "not_configured" || out.error === "halted"
                ? 503
                : 502;
        return send(res, status, out);
      }

      if (req.method === "GET" || req.method === "HEAD") return serveStatic(res, p);
      return send(res, 405, { error: "method_not_allowed" });
    } catch (e) {
      return send(res, e.status || 500, { error: e.status ? e.message : "internal_error" });
    }
  });
}
