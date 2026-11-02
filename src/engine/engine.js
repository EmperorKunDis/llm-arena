// Deterministic, integer-only game engine. Given the same seed and the same
// per-tick commands, step() always produces the same state on every machine, so
// a match can be replayed exactly from its recorded command log.

import { createRng } from "./prng.js";
import { generateMap, tileAt } from "./mapgen.js";
import { RULES, DIRS, TILE, STRUCT } from "./constants.js";

const abs = (n) => (n < 0 ? -n : n);
const cheb = (ax, ay, bx, by) => Math.max(abs(ax - bx), abs(ay - by)); // integer

// Direction scan order per player. Player 1 scans in mirrored (negated) order so
// that every deterministic engine choice is equivariant under the board's 180°
// symmetry + player swap — a precondition for symmetric self-play to draw.
const ORDER_0 = [0, 1, 2, 3, 4, 5, 6, 7];
const ORDER_1 = [4, 5, 6, 7, 0, 1, 2, 3];
const dirOrder = (pi) => (pi === 0 ? ORDER_0 : ORDER_1);

function makePlayer(index, spawn) {
  return {
    index,
    dead: false,
    spawn: { x: spawn.x, y: spawn.y, hp: RULES.SPAWN_HP, energy: RULES.SPAWN_START_ENERGY },
    creeps: new Map(),
    structures: new Map(),
    harvestedTotal: 0,
    killScore: 0,
  };
}

export function createGame(seed, opts = {}) {
  const map = generateMap(seed, opts);
  const state = {
    seed: seed >>> 0,
    map,
    width: map.width,
    height: map.height,
    tick: 0,
    nextId: 1,
    rng: createRng((seed >>> 0) ^ 0x1234567),
    sources: map.sources.map((s, i) => ({ id: `s${i}`, x: s.x, y: s.y, energy: RULES.SOURCE_ENERGY })),
    players: [makePlayer(0, map.spawns[0]), makePlayer(1, map.spawns[1])],
    over: false,
    winner: null, // 0 | 1 | null(draw)
    reason: null,
  };
  return state;
}

// ---- occupancy & lookups -------------------------------------------------

function buildOccupancy(state) {
  const occ = new Set();
  const key = (x, y) => y * state.width + x;
  for (const s of state.sources) occ.add(key(s.x, s.y));
  for (const p of state.players) {
    if (!p.dead) occ.add(key(p.spawn.x, p.spawn.y));
    for (const st of p.structures.values()) occ.add(key(st.x, st.y));
    for (const c of p.creeps.values()) occ.add(key(c.x, c.y));
  }
  return occ;
}

function findEntity(state, id) {
  for (const p of state.players) {
    if (p.creeps.has(id)) return { kind: "creep", owner: p.index, ref: p.creeps.get(id) };
    if (p.structures.has(id)) return { kind: "structure", owner: p.index, ref: p.structures.get(id) };
    if (p.spawn && id === `spawn${p.index}`) return { kind: "spawn", owner: p.index, ref: p.spawn };
  }
  return null;
}

// BFS first-step direction toward a tile adjacent to (tx,ty). Integer-only.
// `order` is the per-player direction scan order (keeps players mirror-equivariant).
function stepToward(state, occ, creep, tx, ty, order) {
  if (cheb(creep.x, creep.y, tx, ty) <= 1) return -1; // already adjacent
  const { width, height } = state;
  const visited = new Uint8Array(width * height);
  const firstDir = new Int8Array(width * height).fill(-1);
  const key = (x, y) => y * width + x;
  const queue = [[creep.x, creep.y]];
  visited[key(creep.x, creep.y)] = 1;
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    for (const d of order) {
      const nx = cx + DIRS[d].dx;
      const ny = cy + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const k = key(nx, ny);
      if (visited[k]) continue;
      if (tileAt(state.map, nx, ny) === TILE.WALL) continue;
      // Blocked by any occupant except we may STAND adjacent to the goal.
      const blocked = occ.has(k) && !(cheb(nx, ny, tx, ty) <= 1 && nx === tx && ny === ty);
      visited[k] = 1;
      firstDir[k] = cx === creep.x && cy === creep.y ? d : firstDir[key(cx, cy)];
      if (cheb(nx, ny, tx, ty) <= 1) return firstDir[k];
      if (!blocked) queue.push([nx, ny]);
    }
  }
  return -1;
}

// ---- command collection (the bot-facing API) -----------------------------

export function createApi(state, playerIndex) {
  const cmds = [];
  const cap = () => cmds.length < RULES.MAX_COMMANDS_PER_TICK;
  return {
    cmds,
    spawnCreep() {
      if (cap()) cmds.push({ op: "spawn" });
    },
    move(id, dir) {
      if (cap() && Number.isInteger(dir) && dir >= 0 && dir < 8) cmds.push({ op: "move", id, dir });
    },
    moveTo(id, x, y) {
      if (cap() && Number.isInteger(x) && Number.isInteger(y)) cmds.push({ op: "moveTo", id, x, y });
    },
    harvest(id, sourceId) {
      if (cap()) cmds.push({ op: "harvest", id, source: sourceId });
    },
    transfer(id) {
      if (cap()) cmds.push({ op: "transfer", id });
    },
    build(id, kind, x, y) {
      if (cap() && (kind === STRUCT.TOWER || kind === STRUCT.WALL)) cmds.push({ op: "build", id, kind, x, y });
    },
    attack(id, target) {
      if (cap()) cmds.push({ op: "attack", id, target });
    },
    _player: playerIndex,
  };
}

// ---- read-only view handed to a bot --------------------------------------

export function buildView(state, playerIndex) {
  const me = state.players[playerIndex];
  const enemy = state.players[1 - playerIndex];
  const walls = [];
  for (let y = 0; y < state.height; y++)
    for (let x = 0; x < state.width; x++)
      if (tileAt(state.map, x, y) === TILE.WALL) walls.push([x, y]);
  const creepList = (p) => [...p.creeps.values()].map((c) => ({ id: c.id, x: c.x, y: c.y, hp: c.hp, carry: c.carry }));
  const structList = (p) => [...p.structures.values()].map((s) => ({ id: s.id, kind: s.kind, x: s.x, y: s.y, hp: s.hp }));
  return {
    tick: state.tick,
    map: { width: state.width, height: state.height, walls },
    sources: state.sources.map((s) => ({ id: s.id, x: s.x, y: s.y, energy: s.energy })),
    me: {
      index: playerIndex,
      spawn: { id: `spawn${me.index}`, x: me.spawn.x, y: me.spawn.y, hp: me.spawn.hp, energy: me.spawn.energy },
      creeps: creepList(me),
      structures: structList(me),
      maxCreeps: RULES.MAX_CREEPS,
      carryCapacity: RULES.CREEP_CARRY,
      costs: { creep: RULES.CREEP_COST, tower: RULES.TOWER_COST, wall: RULES.WALL_COST },
    },
    enemy: {
      index: enemy.index,
      spawn: { id: `spawn${enemy.index}`, x: enemy.spawn.x, y: enemy.spawn.y, hp: enemy.spawn.hp },
      creeps: creepList(enemy),
      structures: structList(enemy),
    },
  };
}

// ---- simultaneous resolution ---------------------------------------------

function freeAdjacentTile(state, occ, x, y, order) {
  for (const d of order) {
    const nx = x + DIRS[d].dx;
    const ny = y + DIRS[d].dy;
    if (tileAt(state.map, nx, ny) === TILE.WALL) continue;
    if (occ.has(ny * state.width + nx)) continue;
    return { x: nx, y: ny };
  }
  return null;
}

export function step(state, cmds0, cmds1) {
  if (state.over) return state;
  const cmdsByPlayer = [cmds0 || [], cmds1 || []];
  const damage = new Map(); // entityId -> accumulated damage
  const addDamage = (id, d) => damage.set(id, (damage.get(id) || 0) + d);

  // Phase 1: spawn creeps.
  for (let pi = 0; pi < 2; pi++) {
    const p = state.players[pi];
    if (p.dead) continue;
    const occ = buildOccupancy(state);
    for (const cmd of cmdsByPlayer[pi]) {
      if (cmd.op !== "spawn") continue;
      if (p.creeps.size >= RULES.MAX_CREEPS) continue;
      if (p.spawn.energy < RULES.CREEP_COST) continue;
      const tile = freeAdjacentTile(state, occ, p.spawn.x, p.spawn.y, dirOrder(pi));
      if (!tile) continue;
      p.spawn.energy -= RULES.CREEP_COST;
      const id = `c${state.nextId++}`;
      p.creeps.set(id, { id, owner: pi, x: tile.x, y: tile.y, hp: RULES.CREEP_HP, carry: 0 });
      occ.add(tile.y * state.width + tile.x);
    }
  }

  // Phase 2: movement (one move per creep), resolved simultaneously.
  const occPreMove = buildOccupancy(state);
  const proposals = new Map(); // targetKey -> [{pi,id,x,y}]
  const moved = new Set();
  for (let pi = 0; pi < 2; pi++) {
    for (const cmd of cmdsByPlayer[pi]) {
      if (cmd.op !== "move" && cmd.op !== "moveTo") continue;
      const creep = state.players[pi].creeps.get(cmd.id);
      if (!creep || moved.has(cmd.id)) continue;
      let dir = -1;
      if (cmd.op === "move") dir = cmd.dir;
      else dir = stepToward(state, occPreMove, creep, cmd.x, cmd.y, dirOrder(pi));
      if (dir < 0) {
        moved.add(cmd.id);
        continue;
      }
      const nx = creep.x + DIRS[dir].dx;
      const ny = creep.y + DIRS[dir].dy;
      if (tileAt(state.map, nx, ny) === TILE.WALL) {
        moved.add(cmd.id);
        continue;
      }
      const k = ny * state.width + nx;
      if (occPreMove.has(k)) {
        moved.add(cmd.id);
        continue;
      } // tile occupied pre-move; no swaps/follows
      if (!proposals.has(k)) proposals.set(k, []);
      proposals.get(k).push({ pi, id: cmd.id, x: nx, y: ny });
      moved.add(cmd.id);
    }
  }
  for (const [, list] of proposals) {
    // Winner = lowest (player, id) for determinism.
    list.sort((a, b) => a.pi - b.pi || (a.id < b.id ? -1 : 1));
    const w = list[0];
    const creep = state.players[w.pi].creeps.get(w.id);
    creep.x = w.x;
    creep.y = w.y;
  }

  // Phase 3: harvest.
  const acted = new Set();
  for (let pi = 0; pi < 2; pi++) {
    const p = state.players[pi];
    for (const cmd of cmdsByPlayer[pi]) {
      if (cmd.op !== "harvest" || acted.has(cmd.id)) continue;
      const creep = p.creeps.get(cmd.id);
      const src = state.sources.find((s) => s.id === cmd.source);
      if (!creep || !src || src.energy <= 0 || creep.carry >= RULES.CREEP_CARRY) continue;
      if (cheb(creep.x, creep.y, src.x, src.y) > 1) continue;
      const amt = Math.min(RULES.HARVEST_PER_TICK, RULES.CREEP_CARRY - creep.carry, src.energy);
      creep.carry += amt;
      src.energy -= amt;
      p.harvestedTotal += amt;
      acted.add(cmd.id);
    }
  }

  // Phase 4: transfer to own spawn, then build structures.
  for (let pi = 0; pi < 2; pi++) {
    const p = state.players[pi];
    for (const cmd of cmdsByPlayer[pi]) {
      if (cmd.op !== "transfer" || acted.has(cmd.id)) continue;
      const creep = p.creeps.get(cmd.id);
      if (!creep || creep.carry <= 0) continue;
      if (cheb(creep.x, creep.y, p.spawn.x, p.spawn.y) > 1) continue;
      p.spawn.energy += creep.carry;
      creep.carry = 0;
      acted.add(cmd.id);
    }
  }
  for (let pi = 0; pi < 2; pi++) {
    const p = state.players[pi];
    const occ = buildOccupancy(state);
    for (const cmd of cmdsByPlayer[pi]) {
      if (cmd.op !== "build" || acted.has(cmd.id)) continue;
      const creep = p.creeps.get(cmd.id);
      if (!creep) continue;
      if (cheb(creep.x, creep.y, cmd.x, cmd.y) > 1) continue;
      if (tileAt(state.map, cmd.x, cmd.y) === TILE.WALL) continue;
      if (occ.has(cmd.y * state.width + cmd.x)) continue;
      const cost = cmd.kind === STRUCT.TOWER ? RULES.TOWER_COST : RULES.WALL_COST;
      if (p.spawn.energy < cost) continue;
      const hp = cmd.kind === STRUCT.TOWER ? RULES.TOWER_HP : RULES.WALL_HP;
      p.spawn.energy -= cost;
      const id = `t${state.nextId++}`;
      p.structures.set(id, { id, owner: pi, kind: cmd.kind, x: cmd.x, y: cmd.y, hp });
      occ.add(cmd.y * state.width + cmd.x);
      acted.add(cmd.id);
    }
  }

  // Phase 5: creep attacks (damage accumulated, applied simultaneously).
  for (let pi = 0; pi < 2; pi++) {
    const p = state.players[pi];
    for (const cmd of cmdsByPlayer[pi]) {
      if (cmd.op !== "attack") continue;
      const creep = p.creeps.get(cmd.id);
      if (!creep) continue;
      const target = findEntity(state, cmd.target);
      if (!target || target.owner === pi) continue;
      if (cheb(creep.x, creep.y, target.ref.x, target.ref.y) > 1) continue;
      addDamage(cmd.target, RULES.CREEP_ATTACK);
    }
  }

  // Phase 6: towers auto-fire at nearest enemy creep in range.
  for (let pi = 0; pi < 2; pi++) {
    const enemy = state.players[1 - pi];
    for (const tower of state.players[pi].structures.values()) {
      if (tower.kind !== STRUCT.TOWER) continue;
      let best = null;
      for (const c of enemy.creeps.values()) {
        const dist = cheb(tower.x, tower.y, c.x, c.y);
        if (dist > RULES.TOWER_RANGE) continue;
        if (!best || dist < best.dist || (dist === best.dist && c.id < best.id))
          best = { id: c.id, dist };
      }
      if (best) addDamage(best.id, RULES.TOWER_DAMAGE);
    }
  }

  // Phase 7: apply damage, remove dead, award score, detect spawn kills.
  const spawnKilled = [false, false];
  for (const [id, dmg] of damage) {
    const ent = findEntity(state, id);
    if (!ent) continue;
    ent.ref.hp -= dmg;
    if (ent.ref.hp > 0) continue;
    const opponent = state.players[1 - ent.owner];
    if (ent.kind === "creep") {
      state.players[ent.owner].creeps.delete(id);
      opponent.killScore += RULES.CREEP_VALUE;
    } else if (ent.kind === "structure") {
      opponent.killScore += ent.ref.kind === STRUCT.TOWER ? RULES.TOWER_VALUE : RULES.WALL_VALUE;
      state.players[ent.owner].structures.delete(id);
    } else if (ent.kind === "spawn") {
      spawnKilled[ent.owner] = true;
    }
  }

  // Phase 8: resolve end conditions.
  if (spawnKilled[0] || spawnKilled[1]) {
    state.players[0].dead = spawnKilled[0];
    state.players[1].dead = spawnKilled[1];
    state.over = true;
    state.reason = "spawn_destroyed";
    state.winner = spawnKilled[0] && spawnKilled[1] ? null : spawnKilled[0] ? 1 : 0;
  }

  state.tick++;
  if (!state.over && state.tick >= RULES.MAX_TICKS) {
    state.over = true;
    state.reason = "tick_limit";
    const score = (p) => p.harvestedTotal + p.killScore;
    const a = score(state.players[0]);
    const b = score(state.players[1]);
    state.winner = a === b ? null : a > b ? 0 : 1;
  }
  return state;
}

export function scoreOf(player) {
  return player.harvestedTotal + player.killScore;
}

// Canonical, order-stable snapshot for equality checks (determinism tests).
export function snapshot(state) {
  const pl = (p) => ({
    dead: p.dead,
    spawn: { ...p.spawn },
    harvestedTotal: p.harvestedTotal,
    killScore: p.killScore,
    creeps: [...p.creeps.values()]
      .map((c) => ({ id: c.id, x: c.x, y: c.y, hp: c.hp, carry: c.carry }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    structures: [...p.structures.values()]
      .map((s) => ({ id: s.id, kind: s.kind, x: s.x, y: s.y, hp: s.hp }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  });
  return {
    tick: state.tick,
    over: state.over,
    winner: state.winner,
    reason: state.reason,
    sources: state.sources.map((s) => ({ id: s.id, energy: s.energy })),
    players: [pl(state.players[0]), pl(state.players[1])],
  };
}
