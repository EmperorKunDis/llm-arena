// Playground: edit a bot, test it locally in a worker, replay it, submit it.
import { getJson, STATIC } from "./data.js";
import { Board, ReplayPlayer, describeCmds } from "./board.js";

const $ = (id) => document.getElementById(id);
const short = (id) => (id || "?").replace(/:free$/, "");
const KEY = "llm-arena-playground-code";

const TEMPLATE = `// Your agent. loop(state, api) runs every tick (max 1500 ticks).
// Win by destroying the enemy spawn, or out-score it (harvested energy + kills).
// Top-level variables persist between ticks — use them as memory.

const roles = {}; // creepId -> "worker" | "soldier"

function dist(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function loop(state, api) {
  const { me, enemy, sources } = state;

  // Economy first, then an army.
  if (me.spawn.energy >= me.costs.creep && me.creeps.length < me.maxCreeps) api.spawnCreep();

  me.creeps.forEach((c, i) => {
    roles[c.id] ||= i % 3 === 2 ? "soldier" : "worker";

    if (roles[c.id] === "worker") {
      if (c.carry >= me.carryCapacity) {
        if (dist(c, me.spawn) <= 1) api.transfer(c.id);
        else api.moveTo(c.id, me.spawn.x, me.spawn.y);
        return;
      }
      const live = sources.filter((s) => s.energy > 0);
      if (!live.length) return;
      const src = live.reduce((a, b) => (dist(c, b) < dist(c, a) ? b : a));
      if (dist(c, src) <= 1) api.harvest(c.id, src.id);
      else api.moveTo(c.id, src.x, src.y);
      return;
    }

    // soldier: hit anything adjacent, otherwise march on the enemy spawn
    const targets = [...enemy.creeps, ...enemy.structures, enemy.spawn];
    const near = targets.find((t) => dist(c, t) <= 1);
    if (near) api.attack(c.id, near.id);
    else api.moveTo(c.id, enemy.spawn.x, enemy.spawn.y);
  });
}
`;

const editor = $("editor");
editor.value = localStorage.getItem(KEY) || TEMPLATE;
let saveTimer;
editor.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(KEY, editor.value);
    $("saved").textContent = "uloženo v tomto prohlížeči";
  }, 400);
});
editor.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const { selectionStart: s, selectionEnd: t } = editor;
  editor.setRangeText("  ", s, t, "end");
});
$("reset").addEventListener("click", () => {
  if (confirm("Nahradit váš kód výchozí šablonou?")) {
    editor.value = TEMPLATE;
    localStorage.setItem(KEY, TEMPLATE);
  }
});
fetch("engine/bot-api.d.ts")
  .then((r) => r.text())
  .then((t) => ($("api").textContent = t))
  .catch(() => ($("api").textContent = "není dostupné"));

// opponents
let opponents = [];
(async () => {
  const { ok, body } = await getJson("opponents");
  const sel = $("opponent");
  if (!ok) return;
  opponents = body.opponents;
  for (const o of opponents) {
    const opt = document.createElement("option");
    opt.value = String(o.id);
    opt.textContent = `${short(o.model)}${o.source === "reference" ? "  (reference)" : o.source === "user" ? "  (agent)" : "  (LLM)"}`;
    sel.append(opt);
  }
  const rush = opponents.find((o) => o.model === "reference/economy");
  if (rush) sel.value = String(rush.id);
})();
$("reseed").addEventListener(
  "click",
  () => ($("seed").value = String(1 + Math.floor(Math.random() * 1e9))),
);

// test match
let player = null;
const board = new Board($("board"));
function renderLog(p) {
  const log = $("cmdlog");
  log.replaceChildren();
  (p.lastCmds() || [[], []]).forEach((list, i) => {
    const col = document.createElement("div");
    const head = document.createElement("div");
    head.className = `p${i} small`;
    head.textContent = i === 0 ? "váš bot" : "soupeř";
    const ul = document.createElement("ul");
    const lines = describeCmds(list);
    for (const l of lines.slice(0, 8)) {
      const li = document.createElement("li");
      li.textContent = l;
      ul.append(li);
    }
    if (!lines.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "(bez příkazů)";
      ul.append(li);
    }
    col.append(head, ul);
    log.append(col);
  });
}

$("run").addEventListener("click", () => {
  const opp = opponents.find((o) => String(o.id) === $("opponent").value);
  const status = $("run-status");
  if (!opp) return (status.textContent = "Vyberte soupeře.");
  status.className = "status";
  status.textContent = "Partie běží…";
  $("run").disabled = true;
  const worker = new Worker("playground-worker.js", { type: "module" });
  const killer = setTimeout(() => {
    worker.terminate();
    status.className = "status err";
    status.textContent =
      "Zkouška překročila časový limit (možná nekonečná smyčka). Server bota posuzuje samostatně podle limitu výpočetní práce.";
    $("run").disabled = false;
  }, 20000);
  worker.onmessage = ({ data }) => {
    if (data.progress)
      return (status.textContent = `Partie běží… tah ${data.progress}`);
    clearTimeout(killer);
    worker.terminate();
    $("run").disabled = false;
    if (!data.record) {
      status.className = "status err";
      status.textContent = data.error.message;
      return;
    }
    const r = data.result;
    const verdict =
      r.winner === null
        ? "Remíza"
        : r.winner === 0
          ? "Vyhráváte"
          : "Prohráváte";
    const why =
      r.reason === "model_error"
        ? r.forfeit === 0
          ? ` — váš bot selhal v tahu ${data.error.tick}: ${data.error.message}`
          : ` — soupeř selhal: ${data.error.message}`
        : r.reason === "spawn_destroyed"
          ? " — zničená základna"
          : " — limit tahů";
    status.className = `status ${r.winner === 0 ? "ok" : r.winner === null ? "" : "err"}`;
    status.textContent = `${verdict}${why} · skóre ${r.scores[0]} : ${r.scores[1]} · ${r.ticks} tahů`;
    player = new ReplayPlayer(data.record, board, (p) => {
      $("tick").textContent = `${p.state.tick} / ${r.ticks}`;
      $("scrub").value = String(p.cursor);
      $("play").textContent = p.playing ? "Pozastavit" : "Přehrát";
      renderLog(p);
    });
    player.speed = 8;
    $("scrub").max = String(player.total);
    $("play").disabled = false;
    player.toggle(true);
  };
  worker.onerror = (e) => {
    clearTimeout(killer);
    worker.terminate();
    $("run").disabled = false;
    status.className = "status err";
    status.textContent = `Nepodařilo se spustit: ${e.message || "chyba pracovníka"}`;
  };
  worker.postMessage({
    seed: Number($("seed").value) || 42,
    code0: editor.value,
    code1: opp.code,
  });
});
$("play").addEventListener("click", () => player && player.toggle());
$("scrub").addEventListener(
  "input",
  (e) => player && player.seek(Number(e.target.value)),
);

// submit
if (STATIC) {
  $("submit").disabled = true;
  $("submit-status").textContent = "Odesílání botů vyžaduje běžící server.";
}
$("submit").addEventListener("click", async () => {
  const status = $("submit-status");
  status.className = "status";
  status.textContent = "Ověřuji bota v izolovaném prostředí serveru…";
  $("submit").disabled = true;
  const { status: code, body } = await getJson("submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: $("name").value, code: editor.value }),
  });
  $("submit").disabled = false;
  if (code === 201) {
    status.className = `status ${body.status === "valid" ? "ok" : "err"}`;
    status.replaceChildren(
      document.createTextNode(
        body.status === "valid"
          ? `Přijato jako ${body.model}. Partie budou zařazeny do fronty. `
          : `Ověření našlo chybu (${body.errorKind}: ${body.errorMessage}). `,
      ),
      Object.assign(document.createElement("a"), {
        href: `bot.html?id=${body.botId}`,
        textContent: "Zobrazit",
      }),
    );
  } else {
    status.className = "status err";
    status.textContent =
      body.message || body.error || `Odeslání selhalo (${code}).`;
  }
});
