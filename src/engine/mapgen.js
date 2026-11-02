// Seeded, point-symmetric map generation. 180° rotational symmetry
// ((x,y) -> (W-1-x, H-1-y)) guarantees both players get an identical board, so
// no map asymmetry can bias the leaderboard.

import { createRng } from "./prng.js";
import { MAP, TILE } from "./constants.js";

export function generateMap(seed, opts = {}) {
  const width = opts.width || MAP.WIDTH;
  const height = opts.height || MAP.HEIGHT; // keep odd
  const rng = createRng(seed ^ 0x5bf03635);

  const tiles = new Array(width * height).fill(TILE.PLAIN);
  const idx = (x, y) => y * width + x;
  const mirror = (x, y) => ({ x: width - 1 - x, y: height - 1 - y });

  // Border walls.
  for (let x = 0; x < width; x++) {
    tiles[idx(x, 0)] = TILE.WALL;
    tiles[idx(x, height - 1)] = TILE.WALL;
  }
  for (let y = 0; y < height; y++) {
    tiles[idx(0, y)] = TILE.WALL;
    tiles[idx(width - 1, y)] = TILE.WALL;
  }

  // Spawns: mirror images of each other.
  const cy = (height - 1) >> 1;
  const spawns = [
    { x: 2, y: cy },
    mirror(2, cy),
  ];

  const reserved = (x, y) =>
    spawns.some((s) => Math.abs(s.x - x) <= 1 && Math.abs(s.y - y) <= 1);

  // Random interior walls, mirrored.
  for (let i = 0; i < (opts.wallAttempts || MAP.WALL_ATTEMPTS); i++) {
    const x = 1 + rng.int(width - 2);
    const y = 1 + rng.int(height - 2);
    const m = mirror(x, y);
    if (reserved(x, y) || reserved(m.x, m.y)) continue;
    if (x === m.x && y === m.y) continue; // centre tile stays clear
    tiles[idx(x, y)] = TILE.WALL;
    tiles[idx(m.x, m.y)] = TILE.WALL;
  }

  // Energy sources, mirrored, placed on plain tiles away from spawns.
  const sources = [];
  let guard = 0;
  while (sources.length < (opts.sourcesPerSide || MAP.SOURCES_PER_SIDE) * 2 && guard++ < 2000) {
    const x = 2 + rng.int(width - 4);
    const y = 2 + rng.int(height - 4);
    const m = mirror(x, y);
    if (x === m.x && y === m.y) continue;
    if (tiles[idx(x, y)] !== TILE.PLAIN || tiles[idx(m.x, m.y)] !== TILE.PLAIN) continue;
    if (reserved(x, y) || reserved(m.x, m.y)) continue;
    if (sources.some((s) => (s.x === x && s.y === y) || (s.x === m.x && s.y === m.y))) continue;
    sources.push({ x, y }, { x: m.x, y: m.y });
  }

  return { width, height, tiles, spawns, sources };
}

export const tileAt = (map, x, y) => {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return TILE.WALL;
  return map.tiles[y * map.width + x];
};
