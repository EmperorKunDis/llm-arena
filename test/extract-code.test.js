import { describe, it, expect } from "vitest";
import { extractCode } from "../src/runner/extract-code.js";

const BOT = "export function loop(state, api) {\n  api.spawnCreep();\n}";

describe("extractCode", () => {
  it("pulls code out of a chatty reply", () => {
    const r = extractCode(`Here is your bot:\n\n\`\`\`javascript\n${BOT}\n\`\`\`\n\nGood luck!`);
    expect(r.code).toBe(BOT);
    expect(r.reason).toBe("fenced_loop");
  });

  it("prefers the block that defines loop over other blocks", () => {
    const reply = `Install:\n\`\`\`bash\nnpm i\n\`\`\`\nHelper:\n\`\`\`js\nconst x = 1;\n\`\`\`\nBot:\n\`\`\`js\n${BOT}\n\`\`\``;
    expect(extractCode(reply).code).toBe(BOT);
  });

  it("ignores <think> reasoning blocks", () => {
    const reply = `<think>maybe \`\`\`js\nfunction loop(){ /* draft */ }\n\`\`\`</think>\nFinal:\n\`\`\`js\n${BOT}\n\`\`\``;
    expect(extractCode(reply).code).toBe(BOT);
  });

  it("tolerates a missing closing fence (truncated reply)", () => {
    expect(extractCode(`Sure!\n\`\`\`js\n${BOT}\n`).code).toBe(BOT);
  });

  it("supports ~~~ fences and no language tag", () => {
    expect(extractCode(`~~~\n${BOT}\n~~~`).code).toBe(BOT);
  });

  it("accepts raw unfenced code only if it looks like a bot", () => {
    expect(extractCode(BOT).reason).toBe("raw");
    expect(extractCode("I cannot help with that.").code).toBe(null);
  });

  it("rejects non-code blocks and oversized code", () => {
    expect(extractCode("```json\n{\"a\":1}\n```").code).toBe(null);
    expect(extractCode("```js\n" + "x".repeat(70000) + " function loop(){}\n```").reason).toBe("too_large");
  });
});
