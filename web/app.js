import { getJson, STATIC } from "./data.js";
import { Board, ReplayPlayer } from "./board.js";

// Leaderboard page. All untrusted strings (model ids, errors) go through
// textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
};
const short = (id) => (id || "?").replace(/:free$/, "");

async function loadLeaderboard() {
  const { ok, body } = await getJson("leaderboard");
  const tbody = $("lb");
  tbody.replaceChildren();
  if (!ok) return ($("lb-meta").textContent = "Žebříček se nepodařilo načíst.");
  $("prov").textContent = body.provisionalGames;
  const hasRating = (r) => r.rating !== null && r.games > 0;
  const rated = body.rows.filter(hasRating);
  const models = body.rows.filter((r) => !r.reference && !r.user);
  $("rated-count").textContent = models.filter(hasRating).length;
  $("valid-count").textContent = models.reduce((n, r) => n + r.validBots, 0);
  $("lb-meta").textContent =
    `Zadání ${body.promptVersion} · ${rated.length} hodnocených · ${body.rows.length - rated.length} zatím bez herního ratingu`;
  let rank = 0;
  for (const r of [...body.rows].sort(
    (a, b) => Number(hasRating(b)) - Number(hasRating(a)),
  )) {
    const name = el("td", {}, [
      el("span", { class: "mono", text: short(r.id) }),
      r.reference
        ? el("span", { class: "badge ref", text: "reference" })
        : null,
      r.user ? el("span", { class: "badge agent", text: "vlastní bot" }) : null,
      !r.reference && r.rating !== null && r.provisional
        ? el("span", { class: "badge prov", text: "předběžné" })
        : null,
      !r.active ? el("span", { class: "badge off", text: "nedostupný" }) : null,
    ]);
    tbody.append(
      el("tr", {}, [
        el("td", { class: "muted", text: hasRating(r) ? String(++rank) : "–" }),
        name,
        el("td", { class: "num", text: hasRating(r) ? String(r.rating) : "–" }),
        el("td", {
          class: "num muted col-ci",
          text: hasRating(r) && r.low !== null ? `${r.low}–${r.high}` : "–",
        }),
        el("td", { class: "num", text: `${r.wins}/${r.losses}/${r.draws}` }),
        el("td", {
          class: "num",
          text:
            r.validShare === null
              ? "–"
              : `${Math.round(r.validShare * 100)} % (${r.validBots}/${r.bots})`,
        }),
      ]),
    );
  }
}

async function loadMatches() {
  const { ok, body } = await getJson("matches?limit=15");
  const box = $("matches");
  box.replaceChildren();
  if (!ok || !body.matches.length)
    return (box.textContent = "Zatím není žádná odehraná partie.");
  for (const m of body.matches.slice(0, 15)) {
    const side = (i) =>
      el("span", {
        class: `p${i}${m.winner === i ? " win" : ""}`,
        text: short(m[`bot${i}`].model),
      });
    const result =
      m.winner === null
        ? "remíza"
        : m.reason === "model_error"
          ? "chyba bota"
          : m.reason === "spawn_destroyed"
            ? "zničená základna"
            : "limit tahů";
    box.append(
      el("div", { class: "match" }, [
        el("span", {}, [
          side(0),
          el("span", { class: "muted", text: " vs " }),
          side(1),
        ]),
        el("a", { href: `replay.html?id=${m.id}`, text: `${result} ▸` }),
      ]),
    );
  }
}

async function loadModels() {
  const { ok, body } = await getJson("models");
  const selA = $("modelA");
  const selB = $("modelB");
  const btn = $("gen");
  if (!ok) {
    $("gen-quota").textContent = "Seznam modelů se nepodařilo načíst.";
    return;
  }
  $("model-count").textContent = body.models.length;
  const keepA = selA.value;
  const keepB = selB.value;
  for (const sel of [selA, selB]) {
    sel.replaceChildren();
    for (const m of body.models)
      sel.append(el("option", { value: m.id, text: short(m.id) }));
  }
  if (body.models.length) {
    selA.value = body.models.some((m) => m.id === keepA)
      ? keepA
      : body.models[0].id;
    selB.value = body.models.some((m) => m.id === keepB)
      ? keepB
      : (body.models[1] || body.models[0]).id;
  }
  const sel = selA;
  const live = body.live;
  btn.disabled = STATIC || !live.enabled || body.models.length < 2;
  if (STATIC) {
    sel.disabled = true;
    selB.disabled = true;
    $("gen-quota").textContent =
      live.note ||
      "Noví boti se generují automaticky v rámci denního limitu OpenRouteru.";
    return;
  }
  $("gen-quota").textContent = live.enabled
    ? `Limit: ${live.perIpDaily} duel denně na návštěvníka. Duel spotřebuje 2 požadavky z denního limitu webu ${live.globalDaily} (využito ${live.usedToday}).`
    : "Živé generování je vypnuté. Uložené boty a jejich záznamy lze dál prohlížet.";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAILURES = {
  quota: "Denní limit je vyčerpaný. Zkuste to zítra.",
  halted: "Generování je pozastavené.",
  not_configured: "Živé generování není nastavené.",
  unknown_model: "Tento model už není v katalogu bezplatných modelů.",
};

function duelSummary(r, models) {
  if (!r) return "";
  const A = short(models[0]);
  const B = short(models[1]);
  if (r.reason === "generation_unavailable")
    return "Duel se nehodnotí: alespoň jeden model nedodal nového bota (nedostupný poskytovatel, odmítnutí nebo stejný kód).";
  if (r.reason === "incomplete_matches")
    return "Duel se nehodnotí: nepodařilo se dokončit obě partie. Výsledek není prohra ani remíza.";
  if (r.reason === "both_failed")
    return `Ani ${A}, ani ${B} nevytvořil spustitelný kód. Duel se nehodnotí.`;
  if (r.reason === "opponent_code_failed") {
    const loser = r.winner === 0 ? 1 : 0;
    const s = r.sides[loser];
    return `${short(models[r.winner])} vyhrává — kód soupeře ${short(models[loser])} selhal (${s.kind || s.outcome}).`;
  }
  const pts = `${r.points[0]} : ${r.points[1]}`;
  return r.winner === null
    ? `Remíza ${pts}`
    : `${short(models[r.winner])} vyhrává ${r.winner === 0 ? pts : `${r.points[1]} : ${r.points[0]}`}`;
}

async function generate() {
  const btn = $("gen");
  const status = $("gen-status");
  const modelA = $("modelA").value;
  const modelB = $("modelB").value;
  if (modelA === modelB) {
    status.className = "status err";
    return (status.textContent = "Vyberte dva různé modely.");
  }
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Spouštím duel…";
  const start = await getJson("duel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelA, modelB }),
  });
  if (start.status !== 202 || !start.body.duelId) {
    status.className = "status err";
    status.textContent =
      { ...FAILURES, pick_two_models: "Vyberte dva různé modely." }[
        start.body.error
      ] ||
      (start.status >= 500
        ? `Chyba serveru (${start.status}). Zkuste to později.`
        : "Požadavek se nepodařil.");
    return loadModels();
  }
  const id = start.body.duelId;
  status.textContent = "Oba modely píšou. Průběh sledujte v panelu výše.";
  for (let i = 0; i < 160; i++) {
    await sleep(3000);
    const { ok, body } = await getJson(`duels/${id}`);
    if (!ok) continue;
    if (body.state === "fighting")
      status.textContent = "Boti jsou hotoví, právě hrají dvě partie…";
    if (body.state === "done") {
      const r = body.result;
      status.className = `status ${["both_failed", "generation_unavailable", "incomplete_matches"].includes(r.reason) ? "err" : "ok"}`;
      status.replaceChildren(
        document.createTextNode(duelSummary(r, body.models) + " "),
      );
      if (r.matches?.length) {
        status.append(
          el("a", {
            href: `replay.html?id=${r.matches[0]}`,
            text: "Přehrát partii ↗",
          }),
        );
        loadFeatured(r.matches[0]);
      }
      await Promise.all([loadModels(), loadLeaderboard(), loadMatches()]);
      return;
    }
  }
  status.className = "status err";
  status.textContent =
    "Duel stále běží. Výsledek později najdete v posledních duelech.";
  loadModels();
}

// ---- live OpenRouter activity ------------------------------------------------
const liveBoxes = new Map(); // jobId -> { root, code, think }
function streamColumn(j, model, side) {
  const col = el("div", { class: "duel-side" });
  col.append(
    el("div", { class: `mono small p${side}`, text: short(model) }),
    el("div", {
      class: "small muted",
      text: j
        ? `${j.elapsedSeconds} s · ${j.contentLength} znaků kódu${j.reasoningLength ? ` · ${j.reasoningLength} znaků přemýšlení` : ""}`
        : "spouštění…",
    }),
  );
  if (j && !j.contentLength && j.reasoningTail)
    col.append(
      el("div", {
        class: "think small",
        text: `přemýšlení… ${j.reasoningTail.slice(-260)}`,
      }),
    );
  if (j && j.state === "done")
    col.append(
      el("div", {
        class: `small ${j.status === "valid" ? "ok-text" : "err-text"}`,
        text: j.status
          ? `bot ${j.status === "valid" ? "je spustitelný" : "obsahuje chybu"}${j.kind ? ` (${j.kind})` : ""}`
          : `${j.outcome}: ${j.kind}`,
      }),
    );
  const pre = el("pre", { class: "code stream" });
  pre.textContent = j?.content || "";
  pre.hidden = !pre.textContent;
  col.append(pre);
  return col;
}

const duelBoxes = new Map();
function renderDuels(list) {
  const box = $("duels-live");
  for (const [id, b] of duelBoxes)
    if (!list.find((d) => d.duelId === id)) (b.remove(), duelBoxes.delete(id));
  for (const d of list) {
    let card = duelBoxes.get(d.duelId);
    const scrolls = card
      ? [...card.querySelectorAll("pre")].map((p) => [
          p.scrollTop,
          p.scrollTop + p.clientHeight >= p.scrollHeight - 20,
        ])
      : [];
    const fresh = el("div", { class: "duel-card" }, [
      el("div", { class: "row small" }, [
        el("span", {}, [
          el("span", { class: "p0 mono", text: short(d.models[0]) }),
          el("span", { class: "muted", text: "  vs  " }),
          el("span", { class: "p1 mono", text: short(d.models[1]) }),
        ]),
        el("span", {
          class: `badge ${d.source === "live" ? "agent" : "prov"}`,
          text: `${d.source === "live" ? "duel návštěvníka" : "automatický duel"} · ${d.state === "writing" ? "tvorba kódu" : d.state === "fighting" ? "partie" : "dokončeno"} · ${d.elapsedSeconds} s`,
        }),
      ]),
      el("div", { class: "duel-cols" }, [
        streamColumn(d.sides[0], d.models[0], 0),
        streamColumn(d.sides[1], d.models[1], 1),
      ]),
    ]);
    if (card) card.replaceWith(fresh);
    else box.append(fresh);
    duelBoxes.set(d.duelId, fresh);
    [...fresh.querySelectorAll("pre")].forEach((p, i) => {
      const [top, atBottom] = scrolls[i] || [0, true];
      p.scrollTop = atBottom ? p.scrollHeight : top;
    });
  }
}

function renderActivity(act) {
  const box = $("live");
  renderDuels(act.duels || []);
  const running = (act.running || []).filter(
    (j) => !String(j.source).startsWith("duel-"),
  );
  const n = running.length + (act.duels || []).length;
  $("live-count").textContent = n
    ? `${(act.duels || []).length ? `${act.duels.length} duel živě` : `${running.length} generování`}`
    : "Právě nic neběží";
  $("live-count").classList.toggle("on", n > 0);
  for (const [id, b] of liveBoxes)
    if (!running.find((j) => j.jobId === id))
      (b.root.remove(), liveBoxes.delete(id));
  if (!running.length && !(act.duels || []).length && !box.children.length)
    box.replaceChildren(
      el("p", {
        class: "small muted",
        text: "Právě neběží žádný duel. Vyberte dva modely níže, nebo počkejte na automatický souboj.",
      }),
    );
  if (
    (act.duels || []).length &&
    box.firstChild &&
    box.firstChild.tagName === "P"
  )
    box.replaceChildren();
  for (const j of running) {
    let b = liveBoxes.get(j.jobId);
    if (!b) {
      if (!liveBoxes.size) box.replaceChildren();
      const head = el("div", { class: "row small" }, [
        el("span", { class: "mono", text: short(j.model) }),
        el("span", {
          class: `badge ${j.source === "live" ? "agent" : "prov"}`,
          text: j.source === "live" ? "návštěvník" : "automaticky",
        }),
      ]);
      const meta = el("div", { class: "small muted" });
      const think = el("div", { class: "think small" });
      const code = el("pre", { class: "code stream" });
      const root = el("div", { class: "livejob" }, [head, meta, think, code]);
      box.append(root);
      b = { root, meta, think, code };
      liveBoxes.set(j.jobId, b);
    }
    b.meta.textContent = `${j.elapsedSeconds} s · ${j.contentLength} znaků kódu${j.reasoningLength ? ` · ${j.reasoningLength} znaků přemýšlení` : ""}`;
    b.think.textContent =
      j.reasoningTail && !j.contentLength
        ? `přemýšlení… ${j.reasoningTail.slice(-300)}`
        : "";
    const atBottom =
      b.code.scrollTop + b.code.clientHeight >= b.code.scrollHeight - 20;
    b.code.textContent =
      j.content || (j.reasoningLength ? "" : "čekám na první tokeny…");
    b.code.hidden = !b.code.textContent;
    if (atBottom) b.code.scrollTop = b.code.scrollHeight;
  }
  const recentDuels = (act.recentDuels || []).slice(0, 6);
  $("recent-gen").replaceChildren(
    ...(recentDuels.length
      ? [el("div", { class: "muted", text: "Poslední duely" })]
      : []),
    ...recentDuels.map((d) =>
      el("div", { class: "match" }, [
        el("span", { text: duelSummary(d.result, d.models) }),
        d.result?.matches?.length
          ? el("a", {
              href: `replay.html?id=${d.result.matches[0]}`,
              text: "přehrát ↗",
            })
          : el("span", { class: "muted", text: `${d.elapsedSeconds}s` }),
      ]),
    ),
  );
}
async function loadActivity() {
  if (STATIC) {
    $("live-count").textContent = "Archiv";
    $("live-hint").textContent =
      "Prohlížíte uložený snímek Areny. Živé duely a generování jsou dostupné na běžícím serveru.";
    $("live").textContent =
      "Výsledky a záznamy níže odpovídají poslednímu sestavení archivu.";
    return;
  }
  const { ok, body } = await getJson("activity");
  if (ok) renderActivity(body);
}

// ---- featured match (latest decisive match, autoplay) -------------------------
let featuredPlayer = null;
async function loadFeatured(matchId) {
  let id = matchId;
  if (!id) {
    const act = STATIC ? null : await getJson("activity");
    const duelMatch =
      act?.ok &&
      (act.body.recentDuels || []).find((d) => d.result?.matches?.length);
    if (duelMatch) id = duelMatch.result.matches[0];
  }
  if (!id) {
    const { ok, body } = await getJson("matches?limit=30");
    if (!ok || !body.matches.length)
      return ($("featured-title").textContent =
        "Zatím není žádná odehraná partie.");
    id = (
      body.matches.find(
        (m) => m.winner !== null && m.reason !== "model_error",
      ) || body.matches[0]
    ).id;
  }
  const d = await getJson(`matches/${id}`);
  if (!d.ok) return;
  const m = d.body;
  $("featured-link").href = `replay.html?id=${m.id}`;
  $("featured-link").hidden = false;
  $("featured-title").replaceChildren(
    el("span", { class: "p0 mono", text: short(m.bots[0].model) }),
    el("span", { class: "muted", text: " vs " }),
    el("span", { class: "p1 mono", text: short(m.bots[1].model) }),
  );
  if (featuredPlayer)
    (featuredPlayer.toggle(false), (featuredPlayer.dead = true));
  const fp = new ReplayPlayer(m.record, new Board($("featured")), (p) => {
    if (p.dead) return;
    $("featured-tick").textContent =
      `tah ${p.state.tick} · skóre ${p.scores()[0]} : ${p.scores()[1]}`;
  });
  fp.speed = 6;
  fp.loop = true;
  fp.toggle(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  featuredPlayer = fp;
}

$("gen").addEventListener("click", generate);
loadActivity();
loadFeatured();
setInterval(loadActivity, 1500);
loadLeaderboard();
loadMatches();
loadModels();
setInterval(() => (loadLeaderboard(), loadMatches()), 30_000);
