import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mapCatalog, DEFAULT_CONTEXT, DEFAULT_OUTPUT } from "../src/catalog.ts"

const raw = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-models.json", import.meta.url), "utf8"),
).data
const models = mapCatalog(raw, () => undefined) // no enrichment in this task
const byId = new Map(models.map((m) => [m.modelID, m]))

test("filters non-completions models (Ruling 9: live fixture has no ===false, 3 text-embedding-*)", () => {
  assert.equal(models.length, 299) // 302 total − 3 text-embedding-* models
  for (const m of models) assert.ok(!/embed/i.test(m.modelID), `embedding leaked: ${m.modelID}`)
  for (const m of models) assert.ok(raw.some((s: any) => s.id === m.modelID))
  // chat models whose supports_completions is null/absent must survive the filter
  for (const id of ["glm-5.2-fast", "gpt-latest", "jev-latest"]) {
    assert.ok(byId.get(id), `${id} must be present`)
  }
})

test("aion-2.0 pricing, limits, maxTokensField", () => {
  const m = byId.get("aion-2.0")!
  assert.equal(m.limit!.context, 131072)
  assert.equal(m.limit!.output, 32768)
  assert.equal(m.capabilities!.tools, true)
  assert.equal(m.compatibility!.maxTokensField, "max_tokens")
  const c = m.cost![0]
  assert.equal(c.input, 0.8)
  assert.equal(c.output, 1.6)
  assert.equal(c.cache!.read, 0.2)
})

test("deepseek-v4.1-flash native reasoning + cache write", () => {
  const m = byId.get("deepseek-v4.1-flash")!
  assert.equal(m.limit!.context, 1048576)
  assert.equal(m.limit!.output, 393216)
  assert.equal(m.compatibility!.reasoningField, "reasoning_content")
  assert.equal(m.cost![0].input, 0.3)
  assert.equal(m.cost![0].output, 1.2)
  // Brief Amendment 5 lists cache.read 0.06, but committed fixture arithmetic is exact:
  // cached_input_nano_usd_per_million_tokens = 6,000,000 → 0.006 USD/M (every sibling
  // value in that oracle matches; this one is a 10× slip vs fixture truth).
  assert.equal(m.cost![0].cache!.read, 0.006)
  assert.equal(m.cost![0].cache!.write, 0.3)
})

test("claude-opus-4.5 no reasoning, zero cache cost (Ruling 12: cache always present)", () => {
  const m = byId.get("claude-opus-4.5")!
  assert.equal(m.limit!.context, 200000)
  assert.equal(m.limit!.output, 64000)
  // supports_reasoning=false and no chat_max_tokens_field → toCompatibility yields
  // undefined (unknown #6/Ruling 4); Model.Info.default sets no compatibility key.
  assert.equal(m.compatibility, undefined)
  assert.equal(m.cost![0].input, 5)
  assert.equal(m.cost![0].output, 25)
  // Ruling 12: gateway reports no cache pricing for it — 0 is the correct representation
  assert.equal(m.cost![0].cache!.read, 0)
  assert.equal(m.cost![0].cache!.write, 0)
})

test("local GPU model gets defaults and no cost", () => {
  const m = byId.get("glm-5.3-local-34d26e50")!
  assert.equal(m.limit!.context, DEFAULT_CONTEXT)
  assert.equal(m.limit!.output, DEFAULT_OUTPUT)
  // Ruling 16: cost is a REQUIRED Model.Info field — default() seeds cost: [] as the
  // canonical "no pricing" representation; the field must never be deleted.
  assert.deepEqual(m.cost, [])
})

test("status active, provider id experiential", () => {
  const m = byId.get("aion-2.0")!
  assert.equal(m.status, "active")
  assert.equal(m.providerID, "experiential")
})
