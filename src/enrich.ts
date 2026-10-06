import type { GatewayModel } from "./types.ts"
import type { ModelMeta } from "./catalog.ts"

// Brief Amendment 2 (unknown #7): models.dev entries have NO capabilities field —
// input/output modalities live on `modalities`, dates on `release_date` (ISO string).
export interface ModelsDevModel {
  id: string
  name?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
}
export type ModelsDevIndex = Record<string, Record<string, ModelsDevModel> | undefined>

// Brief Amendment 1 (Ruling 10): real models.dev provider ids, verified against
// fixtures/modelsdev-trimmed.json. Omitted upstreams — experiential_cloud, local,
// wafer, wally — have no models.dev home.
const UPSTREAM_TO_DEV: Record<string, string[]> = {
  anthropic: ["anthropic"],
  azure_openai: ["azure", "openai"],
  bedrock: ["amazon-bedrock"],
  cerebras: ["cerebras"],
  fireworks: ["fireworks-ai"],
  gemini: ["google"],
  meta: ["meta"],
  openai: ["openai"],
  openrouter: ["openrouter"],
  qwen: ["alibaba"],
  vertex: ["google-vertex"],
  zai: ["zai", "zhipuai"],
  xai: ["xai"],
}

export async function fetchModelsDev(): Promise<ModelsDevIndex> {
  const res = await fetch("https://models.dev/api.json")
  if (!res.ok) throw new Error(`experiential: models.dev returned ${res.status}`)
  // Task 6 A5: the wire shape (models.dev api.json and the captured trimmed
  // fixture, same dump) wraps each provider's model record in a `models` field —
  // normalize here so the declared flat ModelsDevIndex is type-true. Consumers
  // holding a raw/wrapped index (buildEnricher below) still work: providerModels
  // accepts both shapes.
  const raw = (await res.json()) as Record<string, unknown>
  const index: ModelsDevIndex = {}
  for (const [pid, provider] of Object.entries(raw ?? {})) {
    index[pid] = providerModels(provider)
  }
  return index
}

// The index type is stated record-flat, but the wire shape (models.dev api.json and the
// captured trimmed fixture, same dump) wraps each provider's model record in a `models`
// field — unwrap here so both accessor shapes work.
type ProviderEntry = { models?: Record<string, ModelsDevModel> }
function providerModels(p: ModelsDevIndex[string]): Record<string, ModelsDevModel> | undefined {
  const entry = p as ProviderEntry | undefined
  return entry?.models ?? (p as Record<string, ModelsDevModel> | undefined)
}

// Brief Amendment 2's toMeta: released = Date.parse(release_date) when present.
function toMeta(m: ModelsDevModel): ModelMeta {
  return {
    name: m.name,
    released: m.release_date ? Date.parse(m.release_date) : undefined,
    input: m.modalities?.input ?? ["text"],
    output: m.modalities?.output ?? ["text"],
  }
}

export function buildEnricher(dev: ModelsDevIndex): (raw: GatewayModel) => ModelMeta | undefined {
  const global = new Map<string, ModelsDevModel>()
  for (const provider of Object.values(dev)) {
    for (const model of Object.values(providerModels(provider) ?? {})) {
      if (!global.has(model.id)) global.set(model.id, model)
    }
  }
  // Ruling 11 / Amendment 3: exact gateway id first per hint provider, then the
  // dot→dash variant — a lookup key only, never blanket-normalized (glm dotted ids
  // must keep matching exactly).
  const dashed = (id: string) => id.replace(/\./g, "-")
  return (raw: GatewayModel) => {
    const hints = (raw.data_policy?.providers ?? [])
      .flatMap((p) => UPSTREAM_TO_DEV[p.provider] ?? [])
    for (const pid of hints) {
      const models = providerModels(dev[pid])
      const hit = models?.[raw.id] ?? models?.[dashed(raw.id)]
      if (hit) return toMeta(hit)
    }
    const g = global.get(raw.id) ?? global.get(dashed(raw.id))
    return g ? toMeta(g) : undefined
  }
}
