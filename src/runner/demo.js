// Quick manual check: play a few reference match-ups and print the outcome.
//   node src/runner/demo.js
import { runMatch } from "./match.js";
import { loop as idle } from "../bots/idle.js";
import { loop as random } from "../bots/random.js";
import { loop as rush } from "../bots/rush.js";
import { loop as economy } from "../bots/economy.js";

const bots = { idle, random, rush, economy };
const pairs = [
  ["economy", "idle"],
  ["rush", "idle"],
  ["rush", "economy"],
  ["economy", "random"],
];

for (const [a, b] of pairs) {
  const { result } = runMatch(12345, bots[a], bots[b]);
  const who = result.winner === null ? "draw" : result.winner === 0 ? a : b;
  console.log(
    `${a.padEnd(8)} vs ${b.padEnd(8)} -> ${who.padEnd(8)} (${result.reason}, ticks=${result.ticks}, scores=${result.scores.join(":")})`,
  );
}
