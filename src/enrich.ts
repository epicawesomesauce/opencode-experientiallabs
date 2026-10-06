import type { GatewayModel } from "./types.ts"
import type { ModelMeta } from "./catalog.ts"

// Experiential's own catalog API (GET {apiBase}/api/models) is the SOLE metadata
// source — models.dev is gone (user directive). Only the consumed fields are
// declared; the wire payload carries many more (context_window, per-rung
// pricing/capabilities, maker, status, ...) which stay unconsumed — the keyed
// /v1/models 43-field union remains authoritative for limits/pricing/compatibility.
export interface ExperientialCatalogEntry {
  model: {
    slug: string
    display_name?: string
    release_date?: string | null
    input_modalities?: string[]
    output_modalities?: string[]
  }
}

export interface ExperientialCatalog {
  models?: ExperientialCatalogEntry[]
  total?: number
  limit?: number
  offset?: number
  // Tolerant catch-all: the wire wrapper also carries promotions/providers and
  // each entry carries rungs/retention — none of it is consumed here.
  [key: string]: unknown
}

// The catalog lives OUTSIDE the /v1 OpenAPI surface, one level up:
// baseURL https://api.experientiallabs.ai/v1 → apiBase https://api.experientiallabs.ai.
export function deriveApiBase(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, "")
}

const PAGE_LIMIT = 1000
const MAX_PAGES = 10

export async function fetchExperientialCatalog(apiBase: string, apiKey: string): Promise<ExperientialCatalog> {
  const models: ExperientialCatalogEntry[] = []
  let first: ExperientialCatalog | undefined
  // Defensive paging: limit=1000 returns the whole live catalog (938 today), but
  // a full page with total beyond it must not silently truncate — continue with
  // &offset=. Capped so a pathological total can never loop forever.
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = page === 0
      ? `${apiBase}/api/models?limit=${PAGE_LIMIT}`
      : `${apiBase}/api/models?limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      // Same 30s ceiling as the gateway fetch (fix wave M3 intent).
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`experiential: /api/models returned ${res.status}`)
    const body = (await res.json()) as ExperientialCatalog
    first ??= body
    const pageModels = body.models ?? []
    models.push(...pageModels)
    if (pageModels.length < PAGE_LIMIT || models.length >= (body.total ?? models.length)) break
  }
  return { ...(first ?? {}), models }
}

// toMeta: name = display_name, released = Date.parse(release_date) (null →
// omitted), modalities default to ["text"] when the catalog omits them.
function toMeta(m: ExperientialCatalogEntry["model"]): ModelMeta {
  return {
    name: m.display_name,
    released: m.release_date ? Date.parse(m.release_date) : undefined,
    input: m.input_modalities ?? ["text"],
    output: m.output_modalities ?? ["text"],
  }
}

// Join rule (binding): catalog entry.model.slug === raw.id, EXACT — no dot/dash
// variants, no provider hints, no global fallback. A gateway id with no catalog
// slug simply gets NO enrichment (mapModel falls back to id-as-name, ["text"]).
export function buildEnricher(
  catalog: ExperientialCatalog,
): (raw: GatewayModel) => ModelMeta | undefined {
  const bySlug = new Map<string, ExperientialCatalogEntry>()
  for (const entry of catalog.models ?? []) {
    if (typeof entry?.model?.slug === "string" && !bySlug.has(entry.model.slug)) {
      bySlug.set(entry.model.slug, entry)
    }
  }
  return (raw: GatewayModel) => {
    const entry = bySlug.get(raw.id)
    return entry ? toMeta(entry.model) : undefined
  }
}
