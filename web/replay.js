// Replay viewer: re-simulates a stored match from its command log using the
// very same engine module the server runs (served from /engine/).
import { createGame, step, scoreOf } from "./engine/engine.js";
import { TILE } from "./engine/constants.js";
import { getJson } from "./data.js";

const $ = (id) => document.getElementById(id);
const short = (id) => (id || "?").replace(/:free$/, "");
const COLORS = ["#4ecca3", "#ff6b8b"];

const id = Number(new URLSearchParams(location.search).get("id"));
const { ok, body: match } = await getJson(`matches/${id}`);
if (!ok) {
  $("result").textContent = "Match not found.";
  throw new Error("not found");
}
const record = match.record;
const total = record.ticks.length;

let state;
let cursor = 0; // number of recorded ticks applied
const reset = () => {
  state = createGame(record.seed, record.opts || {});
  cursor = 0;
};
const advanceTo = (target) => {
  if (target < cursor) reset();
  while (cursor < target && cursor < total) {
    const [a, b] = record.ticks[cursor];
    step(state, a, b);
    cursor++;
  }
};

const canvas = $("board");
const ctx = canvas.getContext("2d");
function draw() {
  const { width, height, map } = state;
  const cell = Math.floor(Math.min(canvas.width / width, canvas.height / height));
  const ox = Math.floor((canvas.width - cell * width) / 2);
  const oy = Math.floor((canvas.height - cell * height) / 2);
  const at = (x, y) => [ox + x * cell, oy + y * cell];
  ctx.fillStyle = "#0a0d11";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [px, py] = at(x, y);
      ctx.fillStyle = map.tiles[y * width + x] === TILE.WALL ? "#3a434e" : (x + y) % 2 ? "#0f1419" : "#11161c";
      ctx.fillRect(px, py, cell, cell);
    }
  for (const s of state.sources) {
    const [px, py] = at(s.x, s.y);
    ctx.globalAlpha = s.energy > 0 ? 0.35 + 0.65 * (s.energy / 3000) : 0.15;
    ctx.fillStyle = "#ffd54a";
    ctx.fillRect(px + 2, py + 2, cell - 4, cell - 4);
    ctx.globalAlpha = 1;
  }
  state.players.forEach((p, i) => {
    const c = COLORS[i];
    const [sx, sy] = at(p.spawn.x, p.spawn.y);
    ctx.fillStyle = c;
    ctx.globalAlpha = p.dead ? 0.25 : 1;
    ctx.fillRect(sx + 1, sy + 1, cell - 2, cell - 2);
    ctx.globalAlpha = 1;
    for (const st of p.structures.values()) {
      const [px, py] = at(st.x, st.y);
      ctx.fillStyle = c;
      if (st.kind === "tower") {
        ctx.beginPath();
        ctx.moveTo(px + cell / 2, py + 3);
        ctx.lineTo(px + cell - 3, py + cell - 3);
        ctx.lineTo(px + 3, py + cell - 3);
        ctx.fill();
      } else {
        ctx.globalAlpha = 0.6;
        ctx.fillRect(px + 4, py + 4, cell - 8, cell - 8);
        ctx.globalAlpha = 1;
      }
    }
    for (const cr of p.creeps.values()) {
      const [px, py] = at(cr.x, cr.y);
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(px + cell / 2, py + cell / 2, cell * 0.32, 0, Math.PI * 2);
      ctx.fill();
      if (cr.carry > 0) {
        ctx.fillStyle = "#ffd54a";
        ctx.fillRect(px + cell / 2 - 2, py + cell / 2 - 2, 4, 4);
      }
    }
  });
}

function renderInfo() {
  $("tick").textContent = `${state.tick} / ${match.ticks}`;
  $("scrub").value = String(cursor);
  const sides = $("sides");
  sides.replaceChildren();
  state.players.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "side";
    const name = document.createElement("a");
    name.href = `bot.html?id=${match.bots[i].id}`;
    name.className = `p${i} mono`;
    name.textContent = short(match.bots[i].model);
    const score = document.createElement("span");
    score.className = "stats mono small";
    score.textContent = `${scoreOf(p)} pts · ${p.creeps.size} creeps · spawn ${Math.max(0, p.spawn.hp)}`;
    row.append(name, score);
    sides.append(row);
  });
}

function renderResult() {
  const w = match.winner;
  const who = w === null ? "Draw" : `${short(match.bots[w].model)} wins`;
  const why =
    match.reason === "model_error"
      ? `— side ${match.forfeit}'s bot crashed (${match.errors?.[match.forfeit]?.kind || "error"})`
      : match.reason === "spawn_destroyed"
        ? "— spawn destroyed"
        : "— tick limit, higher score";
  $("result").textContent = `${who} ${why}. Seed ${match.seed}.`;
  $("meta").textContent = `match #${match.id}`;
}

let playing = false;
let last = 0;
function frame(t) {
  if (playing) {
    const speed = Number($("speed").value);
    if (t - last > 1000 / 12) {
      last = t;
      advanceTo(Math.min(total, cursor + speed));
      draw();
      renderInfo();
      if (cursor >= total) toggle(false);
    }
  }
  requestAnimationFrame(frame);
}
function toggle(on = !playing) {
  playing = on;
  $("play").textContent = playing ? "Pause" : "Play";
}

$("scrub").max = String(total);
$("play").addEventListener("click", () => toggle());
$("restart").addEventListener("click", () => {
  reset();
  draw();
  renderInfo();
});
$("scrub").addEventListener("input", (e) => {
  advanceTo(Number(e.target.value));
  draw();
  renderInfo();
});

reset();
draw();
renderInfo();
renderResult();
requestAnimationFrame(frame);
