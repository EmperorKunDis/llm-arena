// Child-process entry point: reads one match job as JSON on stdin and writes
// { result, record } as JSON on stdout. Started by isolated.js with an empty
// environment (no API keys) and a hard timeout.
import { runSandboxedMatch } from "./sandboxed-match.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { result, record } = await runSandboxedMatch(job.seed, job.code0, job.code1, job.opts || {});
  process.stdout.write(JSON.stringify({ ok: true, result, record }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message || error) }));
  process.exitCode = 1;
}
