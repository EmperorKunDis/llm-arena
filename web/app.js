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

async function getJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function loadLeaderboard() {
  const { ok, body } = await getJson("/api/leaderboard");
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
  const { ok, body } = await getJson("/api/matches?limit=15");
  const box = $("matches");
  box.replaceChildren();
  if (!ok || !body.matches.length) return (box.textContent = "No matches yet.");
  for (const m of body.matches) {
    const side = (i) =>
      el("span", { class: `p${i}${m.winner === i ? " win" : ""}`, text: short(m[`bot${i}`].model) });
    const result = m.winner === null ? "draw" : m.reason === "model_error" ? "crash" : m.reason.replace("_", " ");
    box.append(
      el("div", { class: "match" }, [
        el("span", {}, [side(0), el("span", { class: "muted", text: " vs " }), side(1)]),
        el("a", { href: `/replay.html?id=${m.id}`, text: `${result} ▸` }),
      ]),
    );
  }
}

async function loadModels() {
  const { ok, body } = await getJson("/api/models");
  const sel = $("model");
  const btn = $("gen");
  sel.replaceChildren();
  if (!ok) return;
  for (const m of body.models) sel.append(el("option", { value: m.id, text: short(m.id) }));
  const live = body.live;
  btn.disabled = !live.enabled || !body.models.length;
  $("gen-quota").textContent = live.enabled
    ? `Limit ${live.perIpDaily}/day per visitor · ${live.usedToday}/${live.globalDaily} used today site-wide`
    : "Live generation is currently off; the leaderboard keeps playing the stored bots.";
}

async function generate() {
  const btn = $("gen");
  const status = $("gen-status");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Asking the model… (free models can take up to a minute)";
  const { status: code, body } = await getJson("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: $("model").value }),
  });
  if (code === 201) {
    status.className = `status ${body.status === "valid" ? "ok" : "err"}`;
    status.replaceChildren(
      document.createTextNode(
        body.status === "valid" ? "Bot is valid and joins the arena. " : `The model's code failed (${body.kind}). `,
      ),
      el("a", { href: `/bot.html?id=${body.botId}`, text: "View code" }),
    );
  } else {
    status.className = "status err";
    const msg = {
      quota: "Daily limit reached — try again tomorrow.",
      halted: "Generation is paused.",
      not_configured: "Live generation is not configured.",
      unknown_model: "That model is not in the free catalog any more.",
    }[body.error];
    status.textContent = msg || `OpenRouter did not answer (${body.kind || body.error}). It will not count against the model.`;
  }
  await loadModels();
}

$("gen").addEventListener("click", generate);
loadLeaderboard();
loadMatches();
loadModels();
setInterval(() => (loadLeaderboard(), loadMatches()), 30_000);
