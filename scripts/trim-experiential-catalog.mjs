import { existsSync, readFileSync, writeFileSync } from "node:fs"
const cache = `${process.env.TEMP}/exp-catalog-full.json`
let full
if (existsSync(cache)) {
  full = JSON.parse(readFileSync(cache, "utf8"))
} else {
  // Keyed capture: Bearer-authed GET also includes the org's local models
  // (keyless serves public rows only). The key is read from the environment
  // and never written anywhere.
  if (!process.env.EXPLABS_API_KEY) throw new Error("no TEMP capture and no EXPLABS_API_KEY for a live fetch")
  const res = await fetch("https://api.experientiallabs.ai/api/models?limit=1000", {
    headers: { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`)
  full = await res.json()
  writeFileSync(cache, JSON.stringify(full))
}

// Exemplar slugs: vision model, local-GPU model (null release_date), the two
// user-named models, and one more real gateway model. No null-display_name /
// empty-modality entries exist in the live catalog — the no-match test uses a
// synthetic id.
const KEEP = ["claude-fable-5.1", "glm-5.3-local-34d26e50", "aion-2.0", "deepseek-v4.1-flash", "glm-5.3-flash"]

// Entry trim: only the consumed model fields + at most 1 provider rung. Org /
// connection linkage and credential fragments on the kept rung are scrubbed to
// null — the catalog shape stays, org-specific identifiers do not reach the repo.
const MODEL_FIELDS = ["slug", "display_name", "release_date", "input_modalities", "output_modalities"]
const RUNG_SCRUB = ["owning_org_id", "provider_connection_id", "connection_alias", "endpoint_credential_last4"]

const models = KEEP.map((slug) => {
  const entry = full.models.find((e) => e.model?.slug === slug)
  if (!entry) throw new Error(`slug not in capture: ${slug}`)
  const model = Object.fromEntries(MODEL_FIELDS.map((k) => [k, entry.model[k]]))
  const rung = entry.providers?.[0]
  const providers = rung
    ? [{ ...rung, ...Object.fromEntries(RUNG_SCRUB.map((k) => [k, null])) }]
    : []
  return { model, providers }
})

// Wrapper shape preserved from the capture; promotions/providers trimmed to
// empty (shape-true, minimal) and the pagination fields kept as captured.
const out = {
  models,
  promotions: [],
  providers: {},
  total: full.total,
  limit: full.limit,
  offset: full.offset,
  integrated_total: full.integrated_total,
}
writeFileSync("fixtures/experiential-catalog.json", JSON.stringify(out, null, 2))
console.log("kept slugs:", KEEP.join(", "))
console.log("missing from capture:", KEEP.filter((s) => !full.models.some((e) => e.model?.slug === s)).join(", ") || "(none)")
