import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { isFresh, loadCatalog, loadExperientialCatalog, CATALOG_TTL_MS, EXPERIENTIAL_META_TTL_MS, type StorageLike } from "../src/cache.ts"
import type { Credential } from "../src/auth.ts"
import type { GatewayModel } from "../src/types.ts"

// Task 6 A8: cache behavior under the TTL + A2 error policy. Global fetch is
// mocked with the repo fixtures exactly like test/index.test.ts (routes:
// {baseURL}/models and https://api.experientiallabs.ai/api/models?limit=1000),
// with a call counter so fresh-hits can be pinned as "no fetch".

const catalogFixture = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-models.json", import.meta.url), "utf8"),
)
const metaFixture = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-catalog.json", import.meta.url), "utf8"),
)

const baseURL = "https://api.experientiallabs.ai/v1"

// Dummy keys only (test/auth.test.ts pattern) — never real xpl_ values.
const cred = (apiKey: string): Credential => ({ apiKey, via: "env" })

const cacheKey = (apiKey: string) =>
  `experiential:catalog:${createHash("sha1").update(apiKey).digest("hex").slice(0, 12)}`

// Real ctx.storage is async on both get and set (dist/promise/storage.d.ts:4-5);
// the mock mirrors that.
const memoryStore = (): StorageLike & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>()
  return {
    map,
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value)
    },
  }
}

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const withFetch = (calls: { count: number }, run: () => Promise<void>) =>
  withMockFetch(
    async (input: unknown) => {
      calls.count++
      const url = String(input)
      if (url.endsWith("/models")) return jsonResponse(catalogFixture)
      if (url === "https://api.experientiallabs.ai/api/models?limit=1000") return jsonResponse(metaFixture)
      throw new Error(`test: unexpected fetch ${url}`)
    },
    run,
  )

const withFailingFetch = (calls: { count: number }, run: () => Promise<void>) =>
  withMockFetch(
    async () => {
      calls.count++
      throw new Error("test: simulated network outage")
    },
    run,
  )

async function withMockFetch(mock: (input: unknown) => Promise<unknown>, run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = mock as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

test("fresh within ttl", () => {
  assert.equal(isFresh({ fetchedAt: Date.now() - 1000 }, 10_000), true)
})

test("stale beyond ttl", () => {
  assert.equal(isFresh({ fetchedAt: Date.now() - 20_000 }, 10_000), false)
})

test("missing is stale", () => {
  assert.equal(isFresh(undefined, 10_000), false)
})

test("loadCatalog fresh-hit serves the cache without fetching", async () => {
  const store = memoryStore()
  const seeded = [{ id: "cached-model" } as GatewayModel]
  store.map.set(cacheKey("env-key"), { fetchedAt: Date.now(), data: seeded })
  const calls = { count: 0 }
  await withFetch(calls, async () => {
    const result = await loadCatalog(store, cred("env-key"), baseURL)
    assert.equal(result, seeded, "fresh-hit returns the cached data unchanged")
    assert.equal(calls.count, 0, "fresh entry must not hit the network")
  })
})

test("loadCatalog miss fetches, stores, and returns the gateway catalog", async () => {
  const store = memoryStore()
  const calls = { count: 0 }
  await withFetch(calls, async () => {
    const before = Date.now()
    const result = await loadCatalog(store, cred("env-key"), baseURL)
    assert.equal(calls.count, 1)
    // fetchCatalog filters the 302-model fixture to the 299 completions models.
    assert.equal(result.length, 299)
    const entry = store.map.get(cacheKey("env-key")) as { fetchedAt: number; data: GatewayModel[] }
    assert.ok(entry, "entry stored under the per-key cache key")
    assert.ok(entry.fetchedAt >= before, "fetchedAt is the fetch time")
    assert.equal(entry.data, result, "the stored data IS what was returned")
  })
})

test("loadCatalog stale entry refetches and overwrites the cache", async () => {
  const store = memoryStore()
  const stale = [{ id: "stale-model" } as GatewayModel]
  store.map.set(cacheKey("env-key"), {
    fetchedAt: Date.now() - CATALOG_TTL_MS - 60_000,
    data: stale,
  })
  const calls = { count: 0 }
  await withFetch(calls, async () => {
    const result = await loadCatalog(store, cred("env-key"), baseURL)
    assert.equal(calls.count, 1, "TTL-stale entries must refetch")
    assert.equal(result.length, 299, "fresh fetch result, not the stale marker")
    const entry = store.map.get(cacheKey("env-key")) as { fetchedAt: number; data: GatewayModel[] }
    assert.equal(entry.data, result)
    assert.equal(entry.data.includes(stale[0]), false, "stale data is gone from the cache")
  })
})

test("loadCatalog fetch failure serves the stale cache (A2 stale-serve)", async () => {
  const store = memoryStore()
  const stale = [{ id: "stale-model" } as GatewayModel]
  const staleEntry = { fetchedAt: Date.now() - CATALOG_TTL_MS - 60_000, data: stale }
  store.map.set(cacheKey("env-key"), staleEntry)
  const calls = { count: 0 }
  await withFailingFetch(calls, async () => {
    const result = await loadCatalog(store, cred("env-key"), baseURL)
    assert.equal(calls.count, 1, "refetch was attempted")
    assert.equal(result, stale, "stale cache is served on fetch failure, no throw")
    assert.equal(store.map.get(cacheKey("env-key")), staleEntry, "failed fetch does not clobber the cache")
  })
})

test("loadCatalog fetch failure with no cache rethrows (A2 first-run degrade)", async () => {
  const store = memoryStore()
  const calls = { count: 0 }
  await withFailingFetch(calls, async () => {
    await assert.rejects(
      loadCatalog(store, cred("env-key"), baseURL),
      /simulated network outage/,
      "no cache + fetch failure must reject so setup can degrade",
    )
  })
})

test("loadExperientialCatalog miss fetches, stores, and returns the catalog metadata", async () => {
  const store = memoryStore()
  const calls = { count: 0 }
  await withFetch(calls, async () => {
    const before = Date.now()
    const result = await loadExperientialCatalog(store, "https://api.experientiallabs.ai", "env-key")
    assert.equal(calls.count, 1)
    assert.deepEqual(result, metaFixture, "the catalog body flows through structurally intact")
    assert.equal(result.models.length, 5)
    const entry = store.map.get("experiential:metadata") as { fetchedAt: number; data: unknown }
    assert.ok(entry, "stored under the shared metadata key")
    assert.ok(entry.fetchedAt >= before)
    assert.equal(entry.data, result)
  })
})

test("loadExperientialCatalog offline serves the stale cache instead of throwing", async () => {
  const store = memoryStore()
  const stale = { models: [{ model: { slug: "claude-fable-5.1", display_name: "Claude Fable 5.1" } }] }
  store.map.set("experiential:metadata", {
    fetchedAt: Date.now() - EXPERIENTIAL_META_TTL_MS - 60_000,
    data: stale,
  })
  const calls = { count: 0 }
  await withFailingFetch(calls, async () => {
    const result = await loadExperientialCatalog(store, "https://api.experientiallabs.ai", "env-key")
    assert.equal(calls.count, 1, "refetch was attempted")
    assert.equal(result, stale, "stale catalog served, enrichment survives the outage")
  })
})

test("loadExperientialCatalog offline with no cache degrades to an empty catalog", async () => {
  const store = memoryStore()
  const calls = { count: 0 }
  await withFailingFetch(calls, async () => {
    const result = await loadExperientialCatalog(store, "https://api.experientiallabs.ai", "env-key")
    assert.equal(calls.count, 1)
    assert.deepEqual(result, {}, "no cache + failure → {}, never a throw")
  })
})

test("same apiKey reuses one storage key and fetches once", async () => {
  const store = memoryStore()
  const calls = { count: 0 }
  await withFetch(calls, async () => {
    const first = await loadCatalog(store, cred("env-key"), baseURL)
    const second = await loadCatalog(store, cred("env-key"), baseURL)
    assert.equal(calls.count, 1, "second load is a fresh-hit, no refetch")
    assert.deepEqual(second, first)
    const catalogKeys = [...store.map.keys()].filter((k) => k.startsWith("experiential:catalog:"))
    assert.equal(catalogKeys.length, 1, "one storage key per api key")
  })
})

test("different apiKeys get different storage keys and refetch", async () => {
  const store = memoryStore()
  const calls = { count: 0 }
  await withFetch(calls, async () => {
    await loadCatalog(store, cred("env-key"), baseURL)
    await loadCatalog(store, cred("conn-key"), baseURL)
    assert.equal(calls.count, 2, "per-key isolation: each key fetches its own catalog")
    const catalogKeys = [...store.map.keys()].filter((k) => /^experiential:catalog:[0-9a-f]{12}$/.test(k))
    assert.equal(catalogKeys.length, 2)
    assert.deepEqual(catalogKeys.sort(), [cacheKey("env-key"), cacheKey("conn-key")].sort())
    // A6: key material never reaches storage, tests, or logs.
    assert.ok(!catalogKeys.some((k) => k.includes("env-key") || k.includes("conn-key")))
  })
})
