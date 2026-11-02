// All quantities are integers. Tuning these changes game balance only; the
// engine stays deterministic regardless of the values.

export const MAP = {
  WIDTH: 25,
  HEIGHT: 21, // odd, so 180° rotation has a single fixed centre tile
  SOURCES_PER_SIDE: 2,
  WALL_ATTEMPTS: 40, // random wall tiles per side (mirrored)
};

export const RULES = {
  MAX_TICKS: 1500,
  MAX_CREEPS: 30, // per player; bounds CPU and keeps matches finite
  MAX_COMMANDS_PER_TICK: 60, // per player; extra commands are ignored

  CREEP_HP: 100,
  CREEP_COST: 50, // energy to spawn one creep
  CREEP_CARRY: 50,
  CREEP_ATTACK: 20,
  CREEP_VALUE: 30, // score awarded to the killer

  HARVEST_PER_TICK: 10,
  SOURCE_ENERGY: 3000, // per source, finite

  SPAWN_HP: 1500,
  SPAWN_START_ENERGY: 100,

  TOWER_HP: 400,
  TOWER_COST: 200,
  TOWER_DAMAGE: 18,
  TOWER_RANGE: 6, // Chebyshev
  TOWER_VALUE: 80,

  WALL_HP: 300,
  WALL_COST: 20,
  WALL_VALUE: 5,
};

// 8 directions, index 0..7. Integer deltas only.
export const DIRS = [
  { dx: 0, dy: -1 }, // 0 N
  { dx: 1, dy: -1 }, // 1 NE
  { dx: 1, dy: 0 }, // 2 E
  { dx: 1, dy: 1 }, // 3 SE
  { dx: 0, dy: 1 }, // 4 S
  { dx: -1, dy: 1 }, // 5 SW
  { dx: -1, dy: 0 }, // 6 W
  { dx: -1, dy: -1 }, // 7 NW
];

export const TILE = { PLAIN: 0, WALL: 1 };
export const STRUCT = { SPAWN: "spawn", TOWER: "tower", WALL: "wall" };
