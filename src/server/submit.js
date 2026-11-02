// User-submitted agents. Code from visitors is exactly as untrusted as code from
// a model: it is dry-run in the QuickJS sandbox here and only ever executed
// server-side inside that sandbox. Limited per IP (hashed) per day.
import { dryRun } from "../generate/pipeline.js";
import { consume, hashIp, quotaConfig } from "./quota.js";

export const SUBMIT_PER_IP_DAILY = 5;
const MAX_CODE = 64 * 1024;

export function slugName(name) {
  const s = String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length >= 3 && s.length <= 24 ? s : null;
}

export async function submitUserBot({ store, ip, name, code, cfg = quotaConfig() }) {
  const slug = slugName(name);
  if (!slug) return { ok: false, error: "bad_name", message: "Name: 3–24 letters, digits or dashes." };
  if (/^(reference|admin|openrouter|system)/.test(slug)) return { ok: false, error: "bad_name", message: "That name is reserved." };
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "no_code" };
  if (code.length > MAX_CODE) return { ok: false, error: "too_large", message: "Code is larger than 64 KB." };
  let ipHash;
  try {
    ipHash = hashIp(ip, cfg.ipSecret);
  } catch {
    return { ok: false, error: "not_configured" };
  }
  const q = consume(store, [{ scope: "submit_ip", key: ipHash, limit: SUBMIT_PER_IP_DAILY }]);
  if (!q.ok) return { ok: false, error: "quota", message: `Limit ${SUBMIT_PER_IP_DAILY} submissions per day.` };

  const run = await dryRun(code);
  const botId = store.insertBot({
    modelId: `user/${slug}`,
    promptVersion: "user",
    source: "user",
    status: run.ok ? "valid" : "invalid",
    errorKind: run.ok ? null : run.error.kind,
    errorMessage: run.ok ? null : run.error.message,
    code,
  });
  if (botId === null) return { ok: false, error: "duplicate", message: "This exact code is already in the arena under that name." };
  return { ok: true, botId, model: `user/${slug}`, status: run.ok ? "valid" : "invalid", errorKind: run.ok ? null : run.error.kind, errorMessage: run.ok ? null : run.error.message };
}
