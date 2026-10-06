import type { GatewayModel } from "./types.ts"
import type { Credential } from "./auth.ts"
import type { ExperientialCatalog } from "./enrich.ts"
import { fetchCatalog } from "./catalog.ts"
import { fetchExperientialCatalog } from "./enrich.ts"
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
export const EXPERIENTIAL_META_TTL_MS = 24 * 60 * 60_000

// Single shared key: one active credential at a time — the per-org catalog
// response simply gets overwritten when the key changes (no per-key metadata
// entries by design).
const EXPERIENTIAL_META_KEY = "experiential:metadata"

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
const isMetaObject = (data: unknown): boolean => typeof data === "object" && data !== null && !Array.isArray(data)

async function readCatalogEntry(store: StorageLike, apiKey: string): Promise<CacheEntry<GatewayModel[]> | undefined> {
  return entryOf<GatewayModel[]>(await store.get(catalogCacheKey(apiKey)), isModelArray)
}

async function readExperientialMetaEntry(store: StorageLike): Promise<CacheEntry<ExperientialCatalog> | undefined> {
  return entryOf<ExperientialCatalog>(await store.get(EXPERIENTIAL_META_KEY), isMetaObject)
}

// Setup path (A3): a cache read with NO fetching — returns whatever is cached
// (fresh or stale, undefined when absent) so setup can populate the transform
// closure without awaiting the network.
export async function peekCatalog(store: StorageLike, cred: Credential): Promise<GatewayModel[] | undefined> {
  return (await readCatalogEntry(store, cred.apiKey))?.data
}

export async function peekExperientialCatalog(store: StorageLike): Promise<ExperientialCatalog | undefined> {
  return (await readExperientialMetaEntry(store))?.data
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

// Catalog metadata enrichment is optional: stale-serve on failure, and with no
// cache degrade to {} (no metadata) — never throw (the plan's asymmetric policy;
// the keyed gateway catalog stays the only required source).
export async function loadExperientialCatalog(
  store: StorageLike,
  apiBase: string,
  apiKey: string,
): Promise<ExperientialCatalog> {
  const cached = await readExperientialMetaEntry(store)
  if (isFresh(cached, EXPERIENTIAL_META_TTL_MS)) return cached!.data
  try {
    const data = await fetchExperientialCatalog(apiBase, apiKey)
    await store.set(EXPERIENTIAL_META_KEY, { fetchedAt: Date.now(), data })
    return data
  } catch {
    if (cached) return cached.data
    return {}
  }
}
