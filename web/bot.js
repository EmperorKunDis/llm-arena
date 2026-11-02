// Shows a stored bot. Model-written code is untrusted text: textContent only.
const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const res = await fetch(`/api/bots/${id}`);
if (!res.ok) {
  $("title").textContent = "Bot not found.";
} else {
  const b = await res.json();
  $("title").textContent = `${b.model.replace(/:free$/, "")} — bot #${b.id}`;
  $("meta").textContent = [
    b.status === "valid" ? "valid" : "invalid",
    b.source,
    `prompt ${b.promptVersion}`,
    b.provider ? `served by ${b.provider}` : null,
    b.modelActual && b.modelActual !== b.model ? `actual model ${b.modelActual}` : null,
    b.normalized ? `normalized: ${b.normalized}` : null,
    b.createdAt,
  ]
    .filter(Boolean)
    .join(" · ");
  if (b.status !== "valid") $("error").textContent = `Failed: ${b.errorKind}${b.errorMessage ? ` — ${b.errorMessage}` : ""}`;
  $("code").textContent = b.code || "(no code was produced)";
}
