import { getJson } from "./data.js";

// Shows a stored bot. Model-written code is untrusted text: textContent only.
const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const { ok, body: b } = await getJson(`bots/${id}`);
if (!ok) {
  $("title").textContent = "Bot se nepodařilo najít.";
} else {
  $("title").textContent = `${b.model.replace(/:free$/, "")} — bot #${b.id}`;
  $("meta").textContent = [
    b.status === "valid" ? "spustitelný" : "chybný",
    b.source,
    `zadání ${b.promptVersion}`,
    b.provider ? `poskytovatel ${b.provider}` : null,
    b.modelActual && b.modelActual !== b.model
      ? `skutečný model ${b.modelActual}`
      : null,
    b.normalized ? `úprava syntaxe: ${b.normalized}` : null,
    b.createdAt,
  ]
    .filter(Boolean)
    .join(" · ");
  if (b.status !== "valid")
    $("error").textContent =
      `Chyba: ${b.errorKind}${b.errorMessage ? ` — ${b.errorMessage}` : ""}`;
  $("code").textContent = b.code || "(model nevytvořil žádný kód)";
}
