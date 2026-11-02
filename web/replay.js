// Replay page: board + per-tick commands + the code of both bots.
import { getJson } from "./data.js";
import { Board, ReplayPlayer, describeCmds } from "./board.js";

const $ = (id) => document.getElementById(id);
const short = (id) => (id || "?").replace(/:free$/, "");

const id = Number(new URLSearchParams(location.search).get("id"));
const { ok, body: match } = await getJson(`matches/${id}`);
if (!ok) {
  $("result").textContent = "Match not found.";
  throw new Error("not found");
}

// result line
{
  const w = match.winner;
  const who = w === null ? "Draw" : `${short(match.bots[w].model)} wins`;
  const why =
    match.reason === "model_error"
      ? `— side ${match.forfeit}'s bot crashed (${match.errors?.[match.forfeit]?.kind || "error"})`
      : match.reason === "spawn_destroyed"
        ? "— spawn destroyed"
        : "— tick limit, higher score";
  $("result").textContent = `${who} ${why}. Seed ${match.seed}.`;
  $("meta").textContent = `#${match.id}`;
}

const sides = $("sides");
const rows = match.bots.map((b, i) => {
  const row = document.createElement("div");
  row.className = "side";
  const name = document.createElement("a");
  name.href = `bot.html?id=${b.id}`;
  name.className = `p${i} mono`;
  name.textContent = short(b.model);
  const stats = document.createElement("span");
  stats.className = "stats mono small";
  row.append(name, stats);
  sides.append(row);
  return stats;
});

function renderLog(player) {
  const log = $("cmdlog");
  log.replaceChildren();
  const cmds = player.lastCmds() || [[], []];
  cmds.forEach((list, i) => {
    const col = document.createElement("div");
    const head = document.createElement("div");
    head.className = `p${i} small`;
    head.textContent = short(match.bots[i].model);
    col.append(head);
    const lines = describeCmds(list);
    const ul = document.createElement("ul");
    for (const l of lines.slice(0, 14)) {
      const li = document.createElement("li");
      li.textContent = l;
      ul.append(li);
    }
    if (!lines.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "(no orders)";
      ul.append(li);
    } else if (lines.length > 14) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = `… +${lines.length - 14} more`;
      ul.append(li);
    }
    col.append(ul);
    log.append(col);
  });
}

const player = new ReplayPlayer(match.record, new Board($("board")), (p) => {
  $("tick").textContent = `${p.state.tick} / ${match.ticks}`;
  $("scrub").value = String(p.cursor);
  $("play").textContent = p.playing ? "Pause" : "Play";
  p.state.players.forEach((pl, i) => {
    rows[i].textContent = `${p.scores()[i]} pts · ${pl.creeps.size} creeps · ${pl.structures.size} buildings · spawn ${Math.max(0, pl.spawn.hp)}`;
  });
  renderLog(p);
});
$("scrub").max = String(player.total);
$("play").addEventListener("click", () => player.toggle());
$("restart").addEventListener("click", () => (player.reset(), player.render()));
$("speed").addEventListener("change", (e) => (player.speed = Number(e.target.value)));
$("scrub").addEventListener("input", (e) => player.seek(Number(e.target.value)));

// code tabs
const codeCache = {};
async function showCode(i) {
  $("tab0").classList.toggle("active", i === 0);
  $("tab1").classList.toggle("active", i === 1);
  const b = match.bots[i];
  $("botlink").href = `bot.html?id=${b.id}`;
  if (!codeCache[i]) {
    const r = await getJson(`bots/${b.id}`);
    codeCache[i] = r.ok ? r.body.code || "(no code)" : "(code unavailable)";
  }
  $("code").textContent = codeCache[i];
}
$("tab0").textContent = `side 0 · ${short(match.bots[0].model)}`;
$("tab1").textContent = `side 1 · ${short(match.bots[1].model)}`;
$("tab0").addEventListener("click", () => showCode(0));
$("tab1").addEventListener("click", () => showCode(1));
showCode(0);
player.toggle(true);
