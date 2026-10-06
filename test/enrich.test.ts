import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { buildEnricher, deriveApiBase, fetchExperientialCatalog } from "../src/enrich.ts"
import { mapModel } from "../src/catalog.ts"
import type { GatewayModel } from "../src/types.ts"

// Fixture truth is the single oracle: the trimmed keyed catalog capture
// (fixtures/experiential-catalog.json) and the captured gateway /v1/models
// response. No values are invented from plan prose.
const catalog = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-catalog.json", import.meta.url), "utf8"),
)
const enrich = buildEnricher(catalog)
const gateway = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-models.json", import.meta.url), "utf8"),
).data as GatewayModel[]
const gatewayById = new Map(gateway.map((m) => [m.id, m]))
const raw = (id: string): GatewayModel => ({ id })

test("slug-exact join happy path: claude-fable-5.1 gets name, release epoch, vision pin", () => {
  const meta = enrich(raw("claude-fable-5.1"))
  assert.ok(meta, "dotted id joins exactly against the identical catalog slug")
  assert.equal(meta.name, "Claude Fable 5.1")
  assert.ok(meta.released !== undefined && meta.released > 0, "release_date parses to a real epoch")
  assert.deepEqual(meta.input, ["text", "image"], "vision pin: input_modalities flow through")
  assert.deepEqual(meta.output, ["text"])
})

test("local-GPU slug joins exactly: GLM 5.3 (local), release date omitted", () => {
  const meta = enrich(raw("glm-5.3-local-34d26e50"))
  assert.ok(meta)
  assert.equal(meta.name, "GLM 5.3 (local)")
  assert.equal(meta.released, undefined, "null release_date must omit the released field")
  assert.deepEqual(meta.input, ["text"])
})

test("no catalog match: synthetic id → undefined (no variants, no fallback)", () => {
  assert.equal(enrich(raw("not-a-real-model")), undefined)
})

test("deriveApiBase strips a trailing /v1 (and a trailing /v1/)", () => {
  assert.equal(deriveApiBase("https://api.experientiallabs.ai/v1"), "https://api.experientiallabs.ai")
  assert.equal(deriveApiBase("https://api.experientiallabs.ai/v1/"), "https://api.experientiallabs.ai")
  assert.equal(deriveApiBase("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000", "local gateway style strips too")
})

test("deriveApiBase is a no-op without a trailing /v1", () => {
  assert.equal(deriveApiBase("https://api.experientiallabs.ai"), "https://api.experientiallabs.ai")
  assert.equal(deriveApiBase("http://127.0.0.1:8000"), "http://127.0.0.1:8000")
})

test("mapModel applies real catalog meta end-to-end (incl. image + video input)", () => {
  const gw = gatewayById.get("glm-5.3-flash")
  assert.ok(gw, "exemplar exists in the gateway fixture")
  const meta = enrich(gw)
  assert.ok(meta)
  const info = mapModel(gw, meta)
  assert.equal(info.name, "GLM-5.3 Flash", "display_name from the catalog, not the id fallback")
  assert.notEqual(info.name, gw.id)
  assert.ok(info.time && info.time.released > 0)
  assert.deepEqual(info.capabilities!.input, ["text", "image", "video"], "modalities flow into capabilities")
  assert.deepEqual(info.capabilities!.output, ["text"])
})

test("fetchExperientialCatalog GETs {apiBase}/api/models?limit=1000 with Bearer auth", async () => {
  const calls: Array<{ url: string; auth: string | undefined }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), auth: init?.headers?.Authorization })
    return { ok: true, status: 200, json: async () => catalog }
  }) as typeof fetch
  try {
    const result = await fetchExperientialCatalog("https://api.experientiallabs.ai", "test-key")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://api.experientiallabs.ai/api/models?limit=1000")
    assert.equal(calls[0].auth, "Bearer test-key")
    assert.equal(result.models!.length, 5, "the catalog body flows through unparsed-object-identity")
    assert.equal(result.total, 938, "wrapper fields are preserved")
  } finally {
    globalThis.fetch = original
  }
})

test("fetchExperientialCatalog pages with &offset= while pages come back full", async () => {
  const stubs = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ model: { slug: `${tag}-${i}` } }))
  const urls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    if (url.includes("offset=")) return { ok: true, status: 200, json: async () => ({ models: stubs(500, "p2"), total: 1500 }) }
    return { ok: true, status: 200, json: async () => ({ models: stubs(1000, "p1"), total: 1500 }) }
  }) as typeof fetch
  try {
    const result = await fetchExperientialCatalog("https://api.experientiallabs.ai", "test-key")
    assert.equal(urls.length, 2, "full page + total beyond it → exactly one continuation fetch")
    assert.ok(urls[1].includes("&offset=1000"), "continuation pages the offset")
    assert.equal(result.models!.length, 1500)
    assert.equal(result.models![0].model.slug, "p1-0")
    assert.equal(result.models![1499].model.slug, "p2-499", "pages concatenate in order")
  } finally {
    globalThis.fetch = original
  }
})

test("fetchExperientialCatalog caps defensive paging at 10 fetches", async () => {
  const stubs = (n: number) => Array.from({ length: n }, (_, i) => ({ model: { slug: `s-${i}` } }))
  let fetches = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    fetches++
    // Pathological server: every page claims to be full with total far beyond reach.
    return { ok: true, status: 200, json: async () => ({ models: stubs(1000), total: 999_999 }) }
  }) as typeof fetch
  try {
    const result = await fetchExperientialCatalog("https://api.experientiallabs.ai", "test-key")
    assert.equal(fetches, 10, "the safety net stops the loop at 10 pages")
    assert.equal(result.models!.length, 10_000)
  } finally {
    globalThis.fetch = original
  }
})
