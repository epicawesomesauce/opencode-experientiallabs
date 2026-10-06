import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { buildEnricher, fetchModelsDev } from "../src/enrich.ts"
import { mapModel } from "../src/catalog.ts"
import type { GatewayModel } from "../src/types.ts"

// Fixture truth is the single oracle (Ruling 13): exact fixture entries are loaded here
// and asserted against — no values are invented from plan prose.
const dev = JSON.parse(
  readFileSync(new URL("../fixtures/modelsdev-trimmed.json", import.meta.url), "utf8"),
)
const enrich = buildEnricher(dev) // enricher unwraps the wire's per-provider `models` wrapper
const gateway = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-models.json", import.meta.url), "utf8"),
).data as GatewayModel[]
const gatewayById = new Map(gateway.map((m) => [m.id, m]))

test("hint-guided match: claude-opus-4.5 resolves via dot→dash variant (azure first in chain)", () => {
  // Real gateway upstreams (experiential fixture): hints become
  // [azure, openai, amazon-bedrock, anthropic] (experiential_cloud maps to nothing).
  // Azure's catalog holds the dashed "claude-opus-4-5" — azure wins before anthropic.
  const raw = {
    id: "claude-opus-4.5",
    data_policy: { providers: [
      { provider: "experiential_cloud" }, { provider: "azure_openai" },
      { provider: "bedrock" }, { provider: "anthropic" },
    ] },
  }
  const meta = enrich(raw as GatewayModel)
  assert.ok(meta) // dot→dash lookup key, not blanket normalization
  // Meta values read from the fixture entry the enricher resolved against (Ruling 13):
  const azureEntry = dev.azure.models["claude-opus-4-5"]
  assert.equal(meta.name, azureEntry.name)
  assert.deepEqual(meta.input, azureEntry.modalities.input)
  assert.deepEqual(meta.output, azureEntry.modalities.output)
})

test("deepseek-v4.1-flash: unmatchable → undefined (brief Amendment 4 flip of plan's fallback oracle)", () => {
  // Fixture upstreams: [experiential_cloud, wally] — neither has a models.dev home.
  // Exact id and any dashed variant are absent from the whole dev index (openrouter ids
  // are vendor-prefixed: deepseek/deepseek-v4.1-flash never matches a bare id).
  const raw = { id: "deepseek-v4.1-flash", data_policy: { providers: [
    { provider: "experiential_cloud" }, { provider: "wally" },
  ] } }
  assert.equal(enrich(raw as GatewayModel), undefined)
})

test("global fallback match: gpt-3.5-turbo resolves with zero mapped hints", () => {
  // Gateway fixture upstreams: ["experiential_cloud"] → empty hint chain (Amendment 1
  // omits experiential_cloud), but the bare id exists in the global index under openai.
  const raw = gatewayById.get("gpt-3.5-turbo")
  assert.ok(raw)
  const meta = enrich(raw)
  assert.ok(meta)
  // Resolved against the openai dev entry (fixture truth), not synthesized defaults:
  assert.equal(meta.name, dev.openai.models["gpt-3.5-turbo"].name)
})

test("no match returns undefined (defaults apply)", () => {
  const raw = { id: "glm-5.3-local-34d26e50", data_policy: { providers: [{ provider: "local" }] } }
  assert.equal(enrich(raw as GatewayModel), undefined)
})

test("vision model gets image input via dev match (hard-assert per Ruling 2)", () => {
  // zai entry verified in fixtures: modalities.input = [text, image, video], dotted
  // glm id matches exactly (blanket normalization forbidden by Ruling 11).
  const meta = enrich({ id: "glm-4.6v", data_policy: { providers: [{ provider: "zai" }] } } as GatewayModel)
  assert.ok(meta)
  assert.ok(meta.input.includes("image"))
})

test("mapModel applies real dev meta end-to-end (Ruling 17: meta path coverage)", () => {
  const raw = gatewayById.get("glm-4.6v")!
  const meta = enrich(raw) // zai hint chain → exact dotted match
  assert.ok(meta)
  const info = mapModel(raw, meta)
  // Name must be the dev display name, not the raw gateway id fallback "glm-4.6v":
  assert.equal(info.name, dev.zai.models["glm-4.6v"].name)
  assert.notEqual(info.name, raw.id)
  // release_date "2025-12-08" parses to a real epoch:
  assert.ok(info.time && info.time.released > 0)
  // caps flow from dev modalities, not the ["text"] default:
  assert.ok(info.capabilities!.input.includes("image"))
})

test("fetchModelsDev normalizes the wrapped wire shape to the flat index (Task 6 A5)", async () => {
  // The captured fixture carries models.dev's real wire shape:
  // { [providerID]: { id, env, npm, name, doc, models: { [modelID]: ModelsDevModel } } }.
  // fetchModelsDev must unwrap the `models` wrapper so the declared flat
  // ModelsDevIndex return type is true (the runtime unwrap used to live only
  // inside providerModels, making this function's type a lie).
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => dev,
  })) as typeof fetch
  try {
    const index = await fetchModelsDev()
    assert.ok(index.anthropic, "provider entry exists")
    assert.equal(
      (index.anthropic as { models?: unknown }).models,
      undefined,
      "the per-provider `models` wrapper must be unwrapped",
    )
    assert.deepEqual(index.anthropic, dev.anthropic.models, "entry IS the provider's model record")
    // The enricher works on the normalized index too — the flat record is its
    // primary shape (providerModels falls through to the record itself):
    const flatEnricher = buildEnricher(index)
    const meta = flatEnricher({
      id: "gpt-3.5-turbo",
      data_policy: { providers: [{ provider: "experiential_cloud" }] },
    } as GatewayModel)
    assert.ok(meta)
    assert.equal(meta.name, dev.openai.models["gpt-3.5-turbo"].name)
  } finally {
    globalThis.fetch = original
  }
})
