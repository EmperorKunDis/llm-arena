// Free models often ignore "return only code" and answer like:
//   "Here is your bot: ```javascript ...code... ``` Good luck!"
// This pulls the actual bot source out of such a reply, robustly:
//   - strips <think>…</think> reasoning blocks (reasoning models)
//   - supports ``` and ~~~ fences, any or no language tag
//   - tolerates a missing closing fence (truncated replies)
//   - prefers the block that defines `loop`, else the longest code block
//   - accepts raw unfenced text only if it clearly looks like a bot

const CODE_LANGS = new Set(["", "js", "javascript", "mjs", "cjs", "jsx", "ts", "typescript", "tsx", "node"]);
const MAX_CHARS = 64 * 1024;
const looksLikeBot = (s) => /\bfunction\s+loop\b|\bloop\s*[=:]|\bexports\.loop\b|\bexport\s+default\b/.test(s);

export function extractCode(reply) {
  if (typeof reply !== "string") return { code: null, reason: "not_text" };
  const text = reply
    .replace(/^﻿/, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, ""); // unterminated think block

  const blocks = [];
  const fence = /(```|~~~)[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)\1/g;
  let m;
  while ((m = fence.exec(text))) blocks.push({ lang: m[2].toLowerCase(), body: m[3].trim() });

  if (blocks.length === 0) {
    const open = text.match(/(```|~~~)[ \t]*([\w+-]*)[^\n]*\n([\s\S]*)$/);
    if (open) blocks.push({ lang: open[2].toLowerCase(), body: open[3].trim() });
  }

  const candidates = blocks.filter((b) => b.body && CODE_LANGS.has(b.lang));
  if (candidates.length === 0) {
    const raw = text.trim();
    if (raw && looksLikeBot(raw)) return finalize(raw, "raw");
    return { code: null, reason: "no_code" };
  }

  const withLoop = candidates.filter((b) => looksLikeBot(b.body));
  const pool = withLoop.length ? withLoop : candidates;
  const best = pool.reduce((a, b) => (b.body.length > a.body.length ? b : a));
  return finalize(best.body, withLoop.length ? "fenced_loop" : "fenced_longest", best.lang);
}

function finalize(code, reason, lang) {
  if (code.length > MAX_CHARS) return { code: null, reason: "too_large" };
  return { code, reason, lang: lang ?? null };
}
