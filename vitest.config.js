import { defineConfig } from "vitest/config";

// Full sandboxed matches and the memory-hog test take several seconds; shared
// CI runners are ~3x slower than a laptop, so the default 5 s timeout is too tight.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
