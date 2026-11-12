// Shared board renderer + replay controller (used by the replay page, the
// featured match on the homepage and the playground). Pure presentation: the
// state comes from the deterministic engine, never from bot code.
import { createGame, step, scoreOf } from "./engine/engine.js";
import { TILE, RULES } from "./engine/constants.js";

export const COLORS = ["#315c9a", "#a75032"];
const SOURCE = "#b88727";

export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  draw(state, lastCmds = null) {
    const { ctx, canvas } = this;
    const { width, height, map } = state;
    const cell = Math.floor(
      Math.min(canvas.width / width, canvas.height / height),
    );
    const ox = Math.floor((canvas.width - cell * width) / 2);
    const oy = Math.floor((canvas.height - cell * height) / 2);
    const at = (x, y) => [ox + x * cell, oy + y * cell];
    const mid = (x, y) => [ox + x * cell + cell / 2, oy + y * cell + cell / 2];

    ctx.fillStyle = "#e9edf3";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [px, py] = at(x, y);
        ctx.fillStyle =
          map.tiles[y * width + x] === TILE.WALL
            ? "#9eaabb"
            : (x + y) % 2
              ? "#edf0f5"
              : "#e5eaf1";
        ctx.fillRect(px, py, cell, cell);
      }

    // tower ranges (faint)
    state.players.forEach((p, i) => {
      for (const st of p.structures.values()) {
        if (st.kind !== "tower") continue;
        const r = RULES.TOWER_RANGE;
        const [px, py] = at(st.x - r, st.y - r);
        ctx.fillStyle =
          i === 0 ? "rgba(49,92,154,0.08)" : "rgba(167,80,50,0.08)";
        ctx.fillRect(px, py, cell * (2 * r + 1), cell * (2 * r + 1));
      }
    });

    for (const s of state.sources) {
      const [px, py] = at(s.x, s.y);
      ctx.globalAlpha =
        s.energy > 0 ? 0.35 + 0.65 * (s.energy / RULES.SOURCE_ENERGY) : 0.12;
      ctx.fillStyle = SOURCE;
      ctx.fillRect(px + 2, py + 2, cell - 4, cell - 4);
      ctx.globalAlpha = 1;
    }

    const bar = (x, y, frac, color) => {
      const [px, py] = at(x, y);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(px + 2, py - 4, cell - 4, 3);
      ctx.fillStyle = color;
      ctx.fillRect(px + 2, py - 4, Math.max(0, (cell - 4) * frac), 3);
    };

    state.players.forEach((p, i) => {
      const c = COLORS[i];
      const [sx, sy] = at(p.spawn.x, p.spawn.y);
      ctx.fillStyle = c;
      ctx.globalAlpha = p.dead ? 0.25 : 1;
      ctx.fillRect(sx + 1, sy + 1, cell - 2, cell - 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#e9edf3";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + cell * 0.3, sy + cell * 0.3, cell * 0.4, cell * 0.4);
      if (p.spawn.hp < RULES.SPAWN_HP)
        bar(p.spawn.x, p.spawn.y, p.spawn.hp / RULES.SPAWN_HP, c);

      for (const st of p.structures.values()) {
        const [px, py] = at(st.x, st.y);
        ctx.fillStyle = c;
        if (st.kind === "tower") {
          ctx.beginPath();
          ctx.moveTo(px + cell / 2, py + 3);
          ctx.lineTo(px + cell - 3, py + cell - 3);
          ctx.lineTo(px + 3, py + cell - 3);
          ctx.fill();
          if (st.hp < RULES.TOWER_HP)
            bar(st.x, st.y, st.hp / RULES.TOWER_HP, c);
        } else {
          ctx.globalAlpha = 0.55;
          ctx.fillRect(px + 3, py + 3, cell - 6, cell - 6);
          ctx.globalAlpha = 1;
        }
      }
      for (const cr of p.creeps.values()) {
        const [cx, cy] = mid(cr.x, cr.y);
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.33, 0, Math.PI * 2);
        ctx.fill();
        if (cr.carry > 0) {
          ctx.fillStyle = SOURCE;
          const s = Math.max(3, (cell * 0.35 * cr.carry) / RULES.CREEP_CARRY);
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        }
        if (cr.hp < RULES.CREEP_HP) bar(cr.x, cr.y, cr.hp / RULES.CREEP_HP, c);
      }
    });

    // What the bots ordered in the tick just played: attacks, harvesting, spawns.
    if (lastCmds) {
      const find = (id) => {
        for (const p of state.players) {
          if (p.creeps.has(id)) return p.creeps.get(id);
          if (p.structures.has(id)) return p.structures.get(id);
          if (id === `spawn${p.index}`) return p.spawn;
        }
        return state.sources.find((s) => s.id === id) || null;
      };
      lastCmds.forEach((cmds, i) => {
        for (const cmd of cmds || []) {
          const from = cmd.id ? find(cmd.id) : null;
          if (cmd.op === "attack" || cmd.op === "harvest") {
            const to = find(cmd.op === "attack" ? cmd.target : cmd.source);
            if (!from || !to) continue;
            const [ax, ay] = mid(from.x, from.y);
            const [bx, by] = mid(to.x, to.y);
            ctx.strokeStyle =
              cmd.op === "attack" ? COLORS[i] : "rgba(139,99,22,0.75)";
            ctx.lineWidth = cmd.op === "attack" ? 3 : 1.5;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          } else if (cmd.op === "spawn") {
            const s = state.players[i].spawn;
            const [px, py] = mid(s.x, s.y);
            ctx.strokeStyle = COLORS[i];
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, cell * 0.9, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });
    }
  }
}

/** Human-readable list of one side's commands for a tick. */
export function describeCmds(cmds) {
  const out = [];
  for (const c of cmds || []) {
    if (c.op === "spawn") out.push("spawn a creep");
    else if (c.op === "move")
      out.push(
        `${c.id} step ${["N", "NE", "E", "SE", "S", "SW", "W", "NW"][c.dir]}`,
      );
    else if (c.op === "moveTo") out.push(`${c.id} → (${c.x}, ${c.y})`);
    else if (c.op === "harvest") out.push(`${c.id} harvest ${c.source}`);
    else if (c.op === "transfer") out.push(`${c.id} deliver energy`);
    else if (c.op === "build")
      out.push(`${c.id} build ${c.kind} (${c.x}, ${c.y})`);
    else if (c.op === "attack") out.push(`${c.id} attack ${c.target}`);
  }
  return out;
}

/** Re-simulates a recorded match tick by tick from its command log. */
export class ReplayPlayer {
  constructor(record, board, onUpdate = () => {}) {
    this.record = record;
    this.board = board;
    this.onUpdate = onUpdate;
    this.total = record.ticks.length;
    this.playing = false;
    this.speed = 4;
    this.last = 0;
    this.reset();
    this.render();
    requestAnimationFrame((t) => this.frame(t));
  }
  reset() {
    this.state = createGame(this.record.seed, this.record.opts || {});
    this.cursor = 0;
  }
  seek(target) {
    if (target < this.cursor) this.reset();
    while (this.cursor < target && this.cursor < this.total) {
      const [a, b] = this.record.ticks[this.cursor];
      step(this.state, a, b);
      this.cursor++;
    }
    this.render();
  }
  lastCmds() {
    return this.cursor > 0 ? this.record.ticks[this.cursor - 1] : null;
  }
  render() {
    this.board.draw(this.state, this.lastCmds());
    this.onUpdate(this);
  }
  scores() {
    return this.state.players.map(scoreOf);
  }
  toggle(on = !this.playing) {
    if (on && this.cursor >= this.total) this.reset();
    this.playing = on;
    this.onUpdate(this);
  }
  frame(t) {
    if (this.playing && t - this.last > 1000 / 12) {
      this.last = t;
      this.seek(Math.min(this.total, this.cursor + this.speed));
      if (this.cursor >= this.total) {
        this.playing = false;
        if (this.loop)
          setTimeout(() => (this.reset(), this.toggle(true)), 2500);
        this.onUpdate(this);
      }
    }
    requestAnimationFrame((tt) => this.frame(tt));
  }
}
