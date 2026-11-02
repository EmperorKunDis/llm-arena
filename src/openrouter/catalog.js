// Free-model catalog. Nothing is hard-coded: the list comes from OpenRouter's
// public /models endpoint and is filtered here. A model counts as "free" only if
// BOTH its id ends in ":free" AND prompt+completion price are zero — on real data
// the zero-price-only set also contains music models and the `openrouter/free`
// router, which picks a model at random and would break "one model per match".

export const MIN_CONTEXT = 8192; // prompt (~2k tokens) + a full bot reply

const isZero = (v) => v !== undefined && v !== null && Number(v) === 0;

export function filterFreeModels(models, { minContext = MIN_CONTEXT } = {}) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => {
      const id = typeof m?.id === "string" ? m.id : "";
      if (!id.endsWith(":free")) return false;
      if (id.startsWith("openrouter/")) return false; // routers, never a fixed model
      if (!isZero(m.pricing?.prompt) || !isZero(m.pricing?.completion)) return false;
      const out = m.architecture?.output_modalities;
      if (Array.isArray(out) && !out.includes("text")) return false;
      if (!Number.isFinite(m.context_length) || m.context_length < minContext) return false;
      return true;
    })
    .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
