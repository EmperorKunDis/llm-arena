// Turns one model call into one stored bot:
//   call OpenRouter -> extract code -> normalize (strip TS types) -> dry-run in
//   the QuickJS sandbox -> store as 'valid' or 'invalid'.
// Infrastructure failures store NO bot (they must never count against a model).
// Normalization is mechanical and identical for every model (no LLM "repair").

import { transform } from "sucrase";
import { buildMessages, PROMPT_VERSION } from "./prompt.js";
import { extractCode } from "../runner/extract-code.js";
import { createBotSandbox } from "../sandbox/quickjs.js";
import { createGame, buildView, step } from "../engine/engine.js";

const DRY_RUN_TICKS = 25;

export function stripTypes(code) {
  try {
    return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code;
  } catch {
    return null;
  }
}

/** Load the bot and play a few ticks against an idle opponent. */
export async function dryRun(code, { seed = 1, ticks = DRY_RUN_TICKS } = {}) {
  const state = createGame(seed);
  const box = await createBotSandbox(code, { seed, map: buildView(state, 0).map });
  if (!box.ok) return { ok: false, error: box.error };
  try {
    for (let t = 0; t < ticks && !state.over; t++) {
      const out = box.tick(buildView(state, 0));
      if (out.error) return { ok: false, error: out.error };
      step(state, out.cmds, []);
    }
    return { ok: true };
  } finally {
    box.dispose();
  }
}

/** Extract + normalize + dry-run a raw model reply. */
export async function prepareBot(reply) {
  const ex = extractCode(reply);
  if (!ex.code) return { status: "invalid", errorKind: ex.reason, errorMessage: "No usable code in the reply." };

  let code = ex.code;
  let normalized = null;
  if (ex.lang === "ts" || ex.lang === "typescript" || ex.lang === "tsx") {
    const js = stripTypes(code);
    if (js) (code = js), (normalized = "ts-strip");
  }
  let run = await dryRun(code);
  if (!run.ok && run.error.kind === "syntax_error" && !normalized) {
    // Mislabelled TypeScript ("```js" with type annotations) is common.
    const js = stripTypes(code);
    if (js && js !== code) {
      const retry = await dryRun(js);
      if (retry.ok || retry.error.kind !== "syntax_error") (code = js), (normalized = "ts-strip-fallback"), (run = retry);
    }
  }
  if (!run.ok) return { status: "invalid", code, normalized, errorKind: run.error.kind, errorMessage: run.error.message };
  return { status: "valid", code, normalized };
}

/**
 * Generate and store one bot for `modelId`. Quota must already be consumed by
 * the caller. Returns { stored, botId?, status?, outcome, kind? }.
 */
export async function generateBot({ modelId, client, store, source = "pool", onDelta = null }) {
  if (store.getSetting("halt")) return { stored: false, outcome: "halted", kind: store.getSetting("halt") };

  const res = await client.complete({ model: modelId, messages: buildMessages(), ...(onDelta ? { onDelta } : {}) });
  if (!res.ok) {
    store.logAttempt({ modelId, source, outcome: res.class, kind: res.kind, message: res.message });
    if (res.class === "stop") store.setSetting("halt", res.kind); // 402 / bad key: stop everything
    return { stored: false, outcome: res.class, kind: res.kind };
  }

  const prep = await prepareBot(res.content);
  if (prep.status === "invalid" && res.finishReason === "length") {
    prep.errorKind = "truncated"; // the reply hit the token cap mid-code
    prep.errorMessage = `Reply cut off at the token limit (${prep.errorMessage || "no code"})`;
  }
  const botId = store.insertBot({
    modelId,
    modelActual: res.modelActual,
    provider: res.provider,
    promptVersion: PROMPT_VERSION,
    source,
    ...prep,
  });
  if (botId === null) {
    store.logAttempt({ modelId, source, outcome: "duplicate", kind: prep.status });
    return { stored: false, outcome: "duplicate" };
  }
  return { stored: true, botId, status: prep.status, outcome: "stored", kind: prep.errorKind ?? null };
}
