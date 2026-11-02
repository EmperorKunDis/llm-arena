// LLM Arena — bot contract. A bot is ONE file that exports `loop(state, api)`.
// `loop` is called once per tick. It may read `state` and issue orders through
// `api`. It may NOT change the game or keep state outside module scope between
// matches. The engine is authoritative: invalid orders are silently ignored.
//
// Determinism: there is no clock, no randomness and no I/O inside a bot. Use
// only `state`. Positions, hp and energy are always integers.

export interface Vec {
  x: number;
  y: number;
}

export interface Creep extends Vec {
  id: string;
  hp: number;
  carry: number; // energy carried, 0..costs.creep-sized capacity
}

export interface Structure extends Vec {
  id: string;
  kind: "spawn" | "tower" | "wall";
  hp: number;
}

export interface Source extends Vec {
  id: string;
  energy: number; // remaining; harvest stops at 0
}

export interface MySide {
  index: 0 | 1;
  spawn: { id: string; x: number; y: number; hp: number; energy: number };
  creeps: Creep[];
  structures: { id: string; kind: "tower" | "wall"; x: number; y: number; hp: number }[];
  maxCreeps: number;
  costs: { creep: number; tower: number; wall: number };
}

export interface EnemySide {
  index: 0 | 1;
  spawn: { id: string; x: number; y: number; hp: number };
  creeps: Creep[];
  structures: { id: string; kind: "tower" | "wall"; x: number; y: number; hp: number }[];
}

export interface GameState {
  tick: number;
  map: { width: number; height: number; walls: [number, number][] };
  sources: Source[];
  me: MySide;
  enemy: EnemySide;
}

export interface Api {
  /** Spend costs.creep from the spawn to create a creep on a free adjacent tile. */
  spawnCreep(): void;
  /** Move a creep one tile. dir: 0=N,1=NE,2=E,3=SE,4=S,5=SW,6=W,7=NW. */
  move(creepId: string, dir: number): void;
  /** Move one step toward (x,y) using the engine's native pathfinding. */
  moveTo(creepId: string, x: number, y: number): void;
  /** Harvest from an adjacent source into the creep's carry. */
  harvest(creepId: string, sourceId: string): void;
  /** Deposit the creep's carry into your adjacent spawn. */
  transfer(creepId: string): void;
  /** Build a structure on an adjacent free tile, paid from spawn energy. */
  build(creepId: string, kind: "tower" | "wall", x: number, y: number): void;
  /** Attack an adjacent enemy creep, structure or spawn. */
  attack(creepId: string, targetId: string): void;
}

export function loop(state: GameState, api: Api): void;
