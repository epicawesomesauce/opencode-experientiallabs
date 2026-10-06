import type { GatewayModel, GatewayModelsResponse } from "./types.ts"
import { Model } from "@opencode/plugin" // Model.Info.default verified in @opencode/schema/dist/model.d.ts (unknown #5)

export const DEFAULT_CONTEXT = 131072
export const DEFAULT_OUTPUT = 32768

export interface ModelMeta {
  name?: string
  released?: number
  input: string[]
  output: string[]
}

export async function fetchCatalog(baseURL: string, apiKey: string): Promise<GatewayModel[]> {
  const res = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`experiential: /models returned ${res.status}`)
  return filterCatalog(((await res.json()) as GatewayModelsResponse).data)
}

// Ruling 9: the live catalog emits supports_completions null/absent (never false) for
// non-completions models; text-embedding-* models are null/absent too, so also drop by id.
function filterCatalog(data: GatewayModel[]): GatewayModel[] {
  return data.filter((m) => m.supports_completions !== false && !/embed/i.test(m.id))
}

const nano = (v?: number | null) => (v == null ? null : v / 1e9)

function toCost(m: GatewayModel) {
  const p = m.pricing
  if (!p) return undefined
  const input = nano(p.input_nano_usd_per_million_tokens)
  const output = nano(p.output_nano_usd_per_million_tokens)
  if (input == null && output == null) return undefined
  const entry: any = { input: input ?? 0, output: output ?? 0 }
  const read = nano(p.cached_input_nano_usd_per_million_tokens)
  const write = nano(p.cache_creation_input_nano_usd_per_million_tokens)
  // Ruling 12: OpenCode requires cache {read, write} on every cost entry — 0 when the
  // gateway omits cache pricing (correct representation, not absence).
  entry.cache = { read: read ?? 0, write: write ?? 0 }
  return [entry]
}

function toCompatibility(m: GatewayModel) {
  const compat: Record<string, string> = {}
  if (m.supports_reasoning) {
    compat.reasoningField = m.reasoning_content_native ? "reasoning_content" : "reasoning"
  }
  if (m.chat_max_tokens_field === "max_tokens" || m.chat_max_tokens_field === "max_completion_tokens") {
    compat.maxTokensField = m.chat_max_tokens_field
  }
  return Object.keys(compat).length ? compat : undefined
}

export function mapModel(raw: GatewayModel, meta?: ModelMeta): Model.Info {
  const info = Model.Info.default("experiential", raw.id)
  info.name = meta?.name ?? raw.id
  info.limit = {
    context: raw.context_window_tokens ?? DEFAULT_CONTEXT,
    output: raw.maximum_output_tokens ?? DEFAULT_OUTPUT,
  }
  info.capabilities = {
    tools: raw.supports_tools === true,
    input: meta?.input ?? ["text"],
    output: meta?.output ?? ["text"],
  }
  const cost = toCost(raw)
  if (cost) info.cost = cost
  // Ruling 16: no-pricing models keep default()'s seeded cost: [] — the canonical
  // "no pricing" representation (cost is a required field; never delete it).
  const compatibility = toCompatibility(raw)
  if (compatibility) info.compatibility = compatibility
  if (meta?.released) info.time = { released: meta.released }
  info.status = "active"
  return info
}

export function mapCatalog(
  raw: GatewayModel[],
  enrich: (raw: GatewayModel) => ModelMeta | undefined,
): Model.Info[] {
  // Apply the same catalog filter here (plan's own oracle: mapped length < raw length —
  // 299 of 302 in the fixture), so downstream tasks can't consume embeddings by mistake.
  return filterCatalog(raw).map((m) => mapModel(m, enrich(m)))
}
