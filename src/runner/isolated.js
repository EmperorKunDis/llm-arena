// Runs a sandboxed match in a separate Node process. Defence in depth on top of
// the QuickJS VM: the child gets no secrets in its environment, a hard wall-clock
// timeout and an output size cap. A timeout or crash here is an INFRASTRUCTURE
// error: the match is retried later and never counted against either model.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./match-process.js", import.meta.url));

export function runMatchIsolated(job, { timeoutMs = 120_000, maxOutputBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH || "/usr/bin:/bin" }, // deliberately no secrets
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    let size = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const infra = (kind, message) => {
      child.kill("SIGKILL");
      settle({ ok: false, infrastructure: true, error: { kind, message } });
    };
    const timer = setTimeout(() => infra("runner_timeout", `Match exceeded ${timeoutMs} ms.`), timeoutMs);

    child.stdout.on("data", (d) => {
      size += d.length;
      if (size > maxOutputBytes) return infra("output_too_large", "Runner output exceeded cap.");
      out.push(d);
    });
    child.on("error", (e) => infra("runner_spawn_failed", String(e.message)));
    child.on("close", (code) => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString("utf8"));
        if (!parsed.ok) return settle({ ok: false, infrastructure: true, error: { kind: "runner_crash", message: parsed.error } });
        settle(parsed);
      } catch {
        settle({ ok: false, infrastructure: true, error: { kind: "runner_crash", message: `Exit code ${code}, unreadable output.` } });
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}
