// Bradley-Terry ratings, shown on the Elo scale with bootstrap confidence
// intervals. Unlike online Elo, the result does not depend on match ORDER, and
// it is recomputed from all valid matches every time.
//
// Each player gets a weak prior (1 virtual win + 1 virtual loss against a fixed
// anchor of strength 1 = 1500 Elo). This keeps unbeaten/winless players finite
// and pins the scale. Draws count as half a win for each side.

import { createRng } from "../engine/prng.js";

/**
 * games: [{ a, b, score }] where score is 1 (a won), 0 (b won) or 0.5 (draw).
 * Returns Map(player -> strength p), anchor p = 1.
 */
export function bradleyTerry(games, players, { iterations = 2000, tolerance = 1e-10 } = {}) {
  const ids = [...players];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const wins = new Float64Array(n).fill(1); // prior: one virtual win vs anchor
  const pairCount = new Map(); // "i,j" (i<j) -> games
  for (const g of games) {
    const i = idx.get(g.a);
    const j = idx.get(g.b);
    if (i === undefined || j === undefined || i === j) continue;
    wins[i] += g.score;
    wins[j] += 1 - g.score;
    const k = i < j ? `${i},${j}` : `${j},${i}`;
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  const pairs = [...pairCount].map(([k, c]) => {
    const [i, j] = k.split(",").map(Number);
    return { i, j, c };
  });

  let p = new Float64Array(n).fill(1);
  for (let it = 0; it < iterations; it++) {
    const denom = new Float64Array(n).fill(2 / 2); // anchor: 2 virtual games, p_anchor = 1 -> 2/(p_i+1)
    for (let i = 0; i < n; i++) denom[i] = 2 / (p[i] + 1);
    for (const { i, j, c } of pairs) {
      const d = c / (p[i] + p[j]);
      denom[i] += d;
      denom[j] += d;
    }
    const next = new Float64Array(n);
    let change = 0;
    for (let i = 0; i < n; i++) {
      next[i] = wins[i] / denom[i];
      change = Math.max(change, Math.abs(next[i] - p[i]) / p[i]);
    }
    p = next;
    if (change < tolerance) break;
  }
  return new Map(ids.map((id, i) => [id, p[i]]));
}

export const toElo = (p) => 1500 + 400 * Math.log10(p);

/**
 * Full rating table with W/L/D, games and a 95 % bootstrap interval.
 * Deterministic: the bootstrap uses a fixed-seed PRNG.
 */
export function rate(games, players, { bootstrap = 200, seed = 20261102 } = {}) {
  const base = bradleyTerry(games, players);
  const samples = new Map([...players].map((id) => [id, []]));
  if (games.length && bootstrap > 0) {
    const rng = createRng(seed);
    for (let b = 0; b < bootstrap; b++) {
      const resample = [];
      for (let k = 0; k < games.length; k++) resample.push(games[rng.int(games.length)]);
      const r = bradleyTerry(resample, players, { iterations: 500, tolerance: 1e-8 });
      for (const [id, p] of r) samples.get(id).push(toElo(p));
    }
  }
  const stats = new Map([...players].map((id) => [id, { wins: 0, losses: 0, draws: 0, games: 0 }]));
  for (const g of games) {
    const A = stats.get(g.a);
    const B = stats.get(g.b);
    if (!A || !B || g.a === g.b) continue;
    A.games++;
    B.games++;
    if (g.score === 1) A.wins++, B.losses++;
    else if (g.score === 0) A.losses++, B.wins++;
    else A.draws++, B.draws++;
  }
  const pct = (arr, q) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  };
  return [...players]
    .map((id) => {
      const s = samples.get(id);
      return {
        id,
        rating: Math.round(toElo(base.get(id))),
        low: s.length ? Math.round(pct(s, 0.025)) : null,
        high: s.length ? Math.round(pct(s, 0.975)) : null,
        ...stats.get(id),
      };
    })
    .sort((a, b) => b.rating - a.rating || (a.id < b.id ? -1 : 1));
}
