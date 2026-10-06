import type { GatewayModel } from "./types.ts"
import type { Credential } from "./auth.ts"
import type { ModelsDevIndex } from "./enrich.ts"
import { fetchCatalog } from "./catalog.ts"
import { fetchModelsDev } from "./enrich.ts"
import { createHash } from "node:crypto"

// Real ctx.storage signature (verified against @opencode/plugin 2.0.24,
// dist/promise/plugin.d.ts:48 + dist/promise/storage.d.ts:4-5): BOTH get and set
// return promises. Every read/write here happens inside async contexts
// (setup / refresh); the sync-only provider transform never touches storage —
// it registers from the closure these loads populate (Task 6 A3).
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface CacheEntry<T> {
  fetchedAt: number
  data: T
}

export const CATALOG_TTL_MS = 10 * 60_000
export const MODELS_DEV_TTL_MS = 24 * 60 * 60_000

const MODELS_DEV_KEY = "experiential:modelsdev"

// A6: cache keys carry a 12-hex sha1 slice of the API key — key material never
// reaches storage, tests, or logs.
function catalogCacheKey(apiKey: string): string {
  return `experiential:catalog:${createHash("sha1").update(apiKey).digest("hex").slice(0, 12)}`
}

export function isFresh(entry: { fetchedAt: number } | undefined, ttlMs: number): boolean {
  return !!entry && Date.now() - entry.fetchedAt < ttlMs
}

// Storage is shared space — a structurally invalid entry is treated as a miss.
function entryOf<T>(raw: unknown, isValidData: (data: unknown) => boolean): CacheEntry<T> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const entry = raw as { fetchedAt?: unknown; data?: unknown }
  return typeof entry.fetchedAt === "number" && isValidData(entry.data)
    ? { fetchedAt: entry.fetchedAt, data: entry.data as T }
    : undefined
}

const isModelArray = (data: unknown): boolean => Array.isArray(data)
const isModelIndex = (data: unknown): boolean => typeof data === "object" && data !== null && !Array.isArray(data)

async function readCatalogEntry(store: StorageLike, apiKey: string): Promise<CacheEntry<GatewayModel[]> | undefined> {
  return entryOf<GatewayModel[]>(await store.get(catalogCacheKey(apiKey)), isModelArray)
}

async function readModelsDevEntry(store: StorageLike): Promise<CacheEntry<ModelsDevIndex> | undefined> {
  return entryOf<ModelsDevIndex>(await store.get(MODELS_DEV_KEY), isModelIndex)
}

// Setup path (A3): a cache read with NO fetching — returns whatever is cached
// (fresh or stale, undefined when absent) so setup can populate the transform
// closure without awaiting the network.
export async function peekCatalog(store: StorageLike, cred: Credential): Promise<GatewayModel[] | undefined> {
  return (await readCatalogEntry(store, cred.apiKey))?.data
}

export async function peekModelsDev(store: StorageLike): Promise<ModelsDevIndex | undefined> {
  return (await readModelsDevEntry(store))?.data
}

// Refresh path: TTL cache with fetch-on-stale.
// A2 (design note, plan line 816): on catalog fetch failure serve the stale
// cache if present — vanilla providers keep listing models even when a key is
// bad or the gateway is down; auth errors surface at request time, exactly like
// built-ins. With no cache at all, rethrow so first-run failure degrades to
// integration-without-provider (the setup/refresh catch preserves that path).
export async function loadCatalog(
  store: StorageLike,
  cred: Credential,
  baseURL: string,
): Promise<GatewayModel[]> {
  const key = catalogCacheKey(cred.apiKey)
  const cached = await readCatalogEntry(store, cred.apiKey)
  if (isFresh(cached, CATALOG_TTL_MS)) return cached!.data
  try {
    const data = await fetchCatalog(baseURL, cred.apiKey)
    await store.set(key, { fetchedAt: Date.now(), data })
    return data
  } catch (err) {
    if (cached) return cached.data
    throw err
  }
}

// models.dev enrichment is optional: stale-serve on failure, and with no cache
// degrade to an empty index — never throw (the plan's asymmetric policy).
export async function loadModelsDev(store: StorageLike): Promise<ModelsDevIndex> {
  const cached = await readModelsDevEntry(store)
  if (isFresh(cached, MODELS_DEV_TTL_MS)) return cached!.data
  try {
    const data = await fetchModelsDev()
    await store.set(MODELS_DEV_KEY, { fetchedAt: Date.now(), data })
    return data
  } catch {
    if (cached) return cached.data
    return {}
  }
}
