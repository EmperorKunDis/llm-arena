// The generation prompt. Kept deliberately short: some free models have small
// context windows, and models read a compact TypeScript interface better than
// prose. Changing anything here = new PROMPT_VERSION (bots are compared per version).

export const PROMPT_VERSION = "v1";

const API = `interface Creep { id: string; x: number; y: number; hp: number; carry: number }
interface Source { id: string; x: number; y: number; energy: number }
interface Building { id: string; kind: "tower" | "wall"; x: number; y: number; hp: number }
interface State {
  tick: number;
  map: { width: number; height: number; walls: [number, number][] };
  sources: Source[];
  me: { spawn: { id: string; x: number; y: number; hp: number; energy: number };
        creeps: Creep[]; structures: Building[]; maxCreeps: number; carryCapacity: number;
        costs: { creep: number; tower: number; wall: number } };
  enemy: { spawn: { id: string; x: number; y: number; hp: number };
           creeps: Creep[]; structures: Building[] };
}
interface Api {
  spawnCreep(): void;                                   // costs me.costs.creep spawn energy
  move(creepId: string, dir: number): void;             // 0=N,1=NE,2=E,3=SE,4=S,5=SW,6=W,7=NW
  moveTo(creepId: string, x: number, y: number): void;  // one step, engine pathfinding
  harvest(creepId: string, sourceId: string): void;     // source must be adjacent
  transfer(creepId: string): void;                      // carry -> your adjacent spawn
  build(creepId: string, kind: "tower" | "wall", x: number, y: number): void; // adjacent free tile, paid from spawn energy
  attack(creepId: string, targetId: string): void;      // adjacent enemy creep/building/spawn
}`;

const RULES = `Rules: a 2-player grid RTS. loop(state, api) is called every tick (max 1500 ticks).
Harvest energy from sources, carry it to your spawn, spend it on creeps, towers (auto-shoot enemy creeps in range 6) and walls.
You win by destroying the enemy spawn; at the tick limit, harvested energy + kill value decides.
"Adjacent" means within 1 tile including diagonals. Invalid orders are ignored. All numbers are integers.`;

const EXAMPLE = `function loop(state, api) {
  const me = state.me;
  if (me.spawn.energy >= me.costs.creep && me.creeps.length < me.maxCreeps) api.spawnCreep();
  for (const c of me.creeps) {
    const src = state.sources.find((s) => s.energy > 0);
    if (c.carry >= me.carryCapacity) { api.moveTo(c.id, me.spawn.x, me.spawn.y); api.transfer(c.id); }
    else if (src) { api.moveTo(c.id, src.x, src.y); api.harvest(c.id, src.id); }
  }
}`;

export function buildMessages() {
  return [
    {
      role: "system",
      content: "You are an expert game AI programmer. You write a single, complete, working bot.",
    },
    {
      role: "user",
      content: `Write the strongest bot you can for this game.

${RULES}

API (TypeScript types for reference):
\`\`\`ts
${API}
\`\`\`

A minimal (weak) example bot:
\`\`\`js
${EXAMPLE}
\`\`\`

Requirements:
- Reply with exactly ONE \`\`\`javascript code block containing the whole bot.
- Plain JavaScript only: no TypeScript type annotations, no import/require, no Date, no async.
- Define a top-level function named loop(state, api). You may keep variables between ticks at the top level.
- Beat other bots: balance economy, defense and attack.`,
    },
  ];
}
