// Runtime configuration from environment variables (see .env.example).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openStore } from "./store.js";
import { createOpenRouterClient } from "../openrouter/client.js";

export function openDefaultStore(env = process.env) {
  const path = env.LLM_ARENA_DB || "data/arena.sqlite";
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return openStore(path);
}

export function defaultClient(env = process.env) {
  return createOpenRouterClient({ apiKey: env.OPENROUTER_API_KEY || null });
}
