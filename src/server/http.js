// Dependency-free HTTP server: JSON API + static frontend. The browser imports
// the engine straight from /engine/*, so the replay viewer runs the exact same
// deterministic code as the server — and never executes bot code.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { leaderboardView, matchesView, matchDetailView, publicBot } from "./views.js";
import { reserveLive } from "./service.js";
import { generateBot } from "../generate/pipeline.js";
import { createJobs } from "./jobs.js";
import { submitUserBot } from "./submit.js";
import { opponents } from "./arena.js";
import { quotaConfig, usage } from "./quota.js";
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
      // The playground worker evaluates the visitor's own bot in their own browser
      // (preview only); it is the only script allowed to use eval. Server-side,
      // every bot still runs exclusively in the QuickJS sandbox.
      const workerCsp = file.endsWith("playground-worker.js")
        ? { "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'" }
        : {};
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        ...workerCsp,
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

export function createArenaServer({ store, client, env = process.env, onGenerated = () => {}, jobs = createJobs() }) {
  // Live generation runs as a background job (free models can write for 2+
  // minutes, longer than Cloudflare's 100 s proxy timeout); the browser polls and
  // sees the streamed text. The same registry shows background pool filling.
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/api/health") return send(res, 200, { status: "ok", sha: DEPLOY_SHA });

      if (req.method === "GET" && p === "/api/leaderboard")
        return send(res, 200, leaderboardView(store), { "Cache-Control": "public, max-age=30" });

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
        return send(res, 200, matchesView(store, limit), { "Cache-Control": "public, max-age=15" });
      }

      let mm = p.match(/^\/api\/matches\/(\d+)$/);
      if (req.method === "GET" && mm) {
        const detail = matchDetailView(store, Number(mm[1]));
        if (!detail) return send(res, 404, { error: "not_found" });
        return send(res, 200, detail, { "Cache-Control": "public, max-age=3600" });
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
        const r = reserveLive({ store, ip: clientIp(req, env), modelId: body.modelId, cfg: quotaConfig(env) });
        if (!r.ok) {
          const status =
            r.error === "quota" ? 429 : r.error === "unknown_model" ? 400 : 503;
          return send(res, status, r);
        }
        const job = jobs.start({ modelId: body.modelId, source: "live" });
        generateBot({ modelId: body.modelId, client, store, source: "live", onDelta: jobs.onDelta(job) })
          .then((out) => {
            jobs.finish(job, { ok: out.stored, ...out });
            if (out.stored) onGenerated(out);
          })
          .catch((e) =>
            jobs.finish(job, { ok: false, outcome: "infra", kind: "internal_error", message: String(e?.message || e).slice(0, 200) }),
          );
        return send(res, 202, jobs.view(job));
      }

      mm = p.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && mm) {
        const job = jobs.get(mm[1]);
        if (!job) return send(res, 404, { error: "not_found" });
        const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
        return send(res, 200, jobs.view(job, { since }), { "Cache-Control": "no-store" });
      }

      if (req.method === "GET" && p === "/api/activity")
        return send(res, 200, jobs.activity(), { "Cache-Control": "no-store" });

      if (req.method === "GET" && p === "/api/opponents")
        return send(res, 200, { opponents: opponents(store) }, { "Cache-Control": "public, max-age=60" });

      if (req.method === "POST" && p === "/api/submit") {
        const body = await readJson(req, 80 * 1024);
        const out = await submitUserBot({ store, ip: clientIp(req, env), name: body.name, code: body.code, cfg: quotaConfig(env) });
        if (out.ok) onGenerated(out);
        const status = out.ok ? 201 : out.error === "quota" ? 429 : out.error === "not_configured" ? 503 : out.error === "duplicate" ? 409 : 400;
        return send(res, status, out);
      }

      if (req.method === "GET" || req.method === "HEAD") return serveStatic(res, p);
      return send(res, 405, { error: "method_not_allowed" });
    } catch (e) {
      return send(res, e.status || 500, { error: e.status ? e.message : "internal_error" });
    }
  });
}
