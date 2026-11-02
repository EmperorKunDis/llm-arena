import { getJson, STATIC } from "./data.js";

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
  if (!ok) return ($("lb-meta").textContent = "Leaderboard unavailable.");
  $("prov").textContent = body.provisionalGames;
  const rated = body.rows.filter((r) => r.rating !== null);
  $("lb-meta").textContent = `Prompt ${body.promptVersion} · ${rated.length} rated · ${body.rows.length - rated.length} without a working bot yet`;
  let rank = 0;
  for (const r of body.rows) {
    const name = el("td", {}, [
      el("span", { class: "mono", text: short(r.id) }),
      r.reference ? el("span", { class: "badge ref", text: "reference" }) : null,
      !r.reference && r.rating !== null && r.provisional ? el("span", { class: "badge prov", text: "provisional" }) : null,
      !r.active ? el("span", { class: "badge off", text: "inactive" }) : null,
    ]);
    tbody.append(
      el("tr", {}, [
        el("td", { class: "muted", text: r.rating === null ? "–" : String(++rank) }),
        name,
        el("td", { class: "num", text: r.rating === null ? "–" : String(r.rating) }),
        el("td", { class: "num muted col-ci", text: r.low === null ? "–" : `${r.low}–${r.high}` }),
        el("td", { class: "num", text: `${r.wins}/${r.losses}/${r.draws}` }),
        el("td", {
          class: "num",
          text: r.validShare === null ? "–" : `${Math.round(r.validShare * 100)} % (${r.validBots}/${r.bots})`,
        }),
      ]),
    );
  }
}

async function loadMatches() {
  const { ok, body } = await getJson("matches?limit=15");
  const box = $("matches");
  box.replaceChildren();
  if (!ok || !body.matches.length) return (box.textContent = "No matches yet.");
  for (const m of body.matches.slice(0, 15)) {
    const side = (i) =>
      el("span", { class: `p${i}${m.winner === i ? " win" : ""}`, text: short(m[`bot${i}`].model) });
    const result = m.winner === null ? "draw" : m.reason === "model_error" ? "crash" : m.reason.replace("_", " ");
    box.append(
      el("div", { class: "match" }, [
        el("span", {}, [side(0), el("span", { class: "muted", text: " vs " }), side(1)]),
        el("a", { href: `replay.html?id=${m.id}`, text: `${result} ▸` }),
      ]),
    );
  }
}

async function loadModels() {
  const { ok, body } = await getJson("models");
  const sel = $("model");
  const btn = $("gen");
  sel.replaceChildren();
  if (!ok) return;
  for (const m of body.models) sel.append(el("option", { value: m.id, text: short(m.id) }));
  const live = body.live;
  btn.disabled = STATIC || !live.enabled || !body.models.length;
  if (STATIC) {
    sel.disabled = true;
    $("gen-quota").textContent = live.note || "New bots are generated automatically several times a day within the free OpenRouter quota.";
    return;
  }
  $("gen-quota").textContent = live.enabled
    ? `Limit ${live.perIpDaily}/day per visitor · ${live.usedToday}/${live.globalDaily} used today site-wide`
    : "Live generation is currently off; the leaderboard keeps playing the stored bots.";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAILURES = {
  quota: "Daily limit reached — try again tomorrow.",
  halted: "Generation is paused.",
  not_configured: "Live generation is not configured.",
  unknown_model: "That model is not in the free catalog any more.",
};

function showResult(status, r) {
  if (r.ok && r.stored) {
    status.className = `status ${r.status === "valid" ? "ok" : "err"}`;
    status.replaceChildren(
      document.createTextNode(
        r.status === "valid"
          ? "Bot is valid and joins the arena — its matches start shortly. "
          : `The model's code failed (${r.kind}). That counts as a broken bot for this model. `,
      ),
      el("a", { href: `bot.html?id=${r.botId}`, text: "View code" }),
    );
    return;
  }
  status.className = "status err";
  if (r.outcome === "duplicate") return (status.textContent = "The model wrote exactly the same bot as before.");
  if (r.outcome === "rejected")
    return (status.textContent = `This model refused the request (${r.kind}). It is skipped and not counted.`);
  status.textContent = `OpenRouter did not deliver a reply (${r.kind || "no response"}). This does not count against the model.`;
}

async function generate() {
  const btn = $("gen");
  const status = $("gen-status");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Starting…";
  const start = await getJson("generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: $("model").value }),
  });
  if (start.status !== 202 || !start.body.jobId) {
    status.className = "status err";
    status.textContent =
      FAILURES[start.body.error] ||
      (start.status >= 500 ? `Server error (${start.status}). Please try again later.` : "Request failed.");
    return loadModels();
  }
  const id = start.body.jobId;
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const { ok, body } = await getJson(`jobs/${id}`);
    if (!ok) continue; // transient; keep polling
    if (body.state === "done") {
      showResult(status, body);
      await Promise.all([loadModels(), loadLeaderboard()]);
      return;
    }
    status.textContent = `${short(body.model)} is writing its bot… ${body.elapsedSeconds}s (free models can take 1–3 minutes)`;
  }
  status.className = "status err";
  status.textContent = "Still running after 6 minutes — check the leaderboard later.";
  loadModels();
}

$("gen").addEventListener("click", generate);
loadLeaderboard();
loadMatches();
loadModels();
setInterval(() => (loadLeaderboard(), loadMatches()), 30_000);
