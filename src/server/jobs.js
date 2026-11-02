// Registry of generation jobs (live button + background pool filling). Keeps the
// streamed reasoning/code text so visitors can watch a model write its bot.
import { randomUUID } from "node:crypto";

const MAX_TEXT = 120_000;

export function createJobs({ keepMs = 60 * 60 * 1000, keepFinished = 30 } = {}) {
  const jobs = new Map();

  const prune = () => {
    const cutoff = Date.now() - keepMs;
    const finished = [...jobs.values()].filter((j) => j.state === "done").sort((a, b) => b.finishedAt - a.finishedAt);
    for (const j of finished.slice(keepFinished)) jobs.delete(j.id);
    for (const [id, j] of jobs) if (j.startedAt < cutoff && j.state === "done") jobs.delete(id);
  };

  const summary = (j, { since = 0, tail = 0 } = {}) => ({
    ...(j.result || {}),
    jobId: j.id,
    state: j.state,
    source: j.source,
    model: j.modelId,
    startedAt: new Date(j.startedAt).toISOString(),
    elapsedSeconds: Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000),
    contentLength: j.content.length,
    reasoningLength: j.reasoning.length,
    content: tail ? j.content.slice(-tail) : j.content.slice(since),
    reasoningTail: j.reasoning.slice(-600),
  });

  return {
    start({ modelId, source }) {
      prune();
      const job = { id: randomUUID(), state: "running", modelId, source, startedAt: Date.now(), content: "", reasoning: "", result: null };
      jobs.set(job.id, job);
      return job;
    },
    onDelta(job) {
      return (d) => {
        if (d.content && job.content.length < MAX_TEXT) job.content += d.content;
        if (d.reasoning && job.reasoning.length < MAX_TEXT) job.reasoning += d.reasoning;
      };
    },
    finish(job, result) {
      job.result = result;
      job.state = "done";
      job.finishedAt = Date.now();
    },
    get: (id) => jobs.get(id),
    view: (job, opts) => summary(job, opts),
    activity() {
      const all = [...jobs.values()];
      return {
        running: all.filter((j) => j.state === "running").map((j) => summary(j, { tail: 4000 })),
        recent: all
          .filter((j) => j.state === "done")
          .sort((a, b) => b.finishedAt - a.finishedAt)
          .slice(0, 10)
          .map((j) => ({ ...summary(j, { tail: 1 }), content: undefined, reasoningTail: undefined })),
      };
    },
  };
}
