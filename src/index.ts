import { Plugin, Provider } from "@opencode/plugin"
import type { Model } from "@opencode/plugin"
import { mapCatalog } from "./catalog.ts"
import { buildEnricher } from "./enrich.ts"
import { resolveCredential, type Credential } from "./auth.ts"
import { loadCatalog, loadModelsDev, peekCatalog, peekModelsDev, type StorageLike } from "./cache.ts"
import { createHash } from "node:crypto"

const DEFAULT_BASE_URL = "https://api.experientiallabs.ai/v1"

export default Plugin.define({
  id: "experiential",
  async setup(ctx) {
    const baseURL = (ctx.options as { baseURL?: string } | undefined)?.baseURL ?? DEFAULT_BASE_URL

    // 1) Integration (Amendment 2) — registered UNCONDITIONALLY so "Experiential"
    //    appears in /connect with a key-paste method even before any credential
    //    exists; that is how users paste the xpl_ key in the first place.
    await ctx.integration.transform((editor) => {
      editor.update("experiential", (integration) => {
        integration.name = "Experiential"
      })
      editor.method.update({
        integrationID: "experiential",
        method: {
          type: "key",
          label: "API key",
          form: [
            {
              type: "string",
              key: "apiKey",
              title: "API key",
              description:
                "Experiential Labs API key (starts with xpl_). Falls back to the EXPLABS_API_KEY environment variable.",
              placeholder: "xpl_...",
              required: true,
            },
          ],
        },
      })
    })

    // 2) Closure state (Task 6 A3): transform bodies are sync-only
    //    (dist/promise/registration.d.ts:12), so every value they read lives in
    //    this closure. setup resolves the credential and reads the local cache
    //    (storage reads only — registration never awaits the network); the async
    //    refresh below fetches through the TTL cache and republishes via
    //    ctx.provider.reload(). Real ctx.storage get/set are async
    //    (dist/promise/storage.d.ts:4-5) — fine, both are awaited here in
    //    async contexts, never from a transform.
    const store: StorageLike | undefined = ctx.storage
    let cred: Credential | undefined
    let connection: Awaited<ReturnType<typeof ctx.integration.connection.active>> | undefined
    let models: Model.Info[] = []
    // Fingerprint of what the transform last served the host — (via, keyHash,
    // baseURL) signature (A7) plus a hash of the mapped models. refresh
    // reloads ONLY when this changes; matching it is the fixed point that
    // terminates the reload loop, including under persistent fetch failure
    // (stale-served data hashes the same as what was just registered).
    let registeredFp: string | undefined
    const fingerprint = (c: Credential, mapped: Model.Info[]): string =>
      `${c.via}:${createHash("sha1").update(c.apiKey).digest("hex").slice(0, 12)}:${baseURL}:${createHash("sha1").update(JSON.stringify(mapped)).digest("hex")}`

    try {
      cred = await resolveCredential(ctx)
      if (cred) {
        // Fix round R1, finding 2: the sourceConnection lookup runs only when the
        // credential came from a connection (env-only setups never call it), and
        // inside this try so a transient rejection degrades to "integration
        // registered, provider skipped" instead of killing setup.
        if (cred.via === "connection") connection = await ctx.integration.connection.active("experiential")
        // Task 6 swaps Task 4's two live-fetch load lines for cached loads: a
        // cache peek here (fresh OR stale, never a fetch), with the actual
        // fetching deferred to the refresh below.
        const cached = store ? await peekCatalog(store, cred) : undefined
        const devIndex = store ? await peekModelsDev(store) : undefined
        if (cached) models = mapCatalog(cached, buildEnricher(devIndex ?? {}))
      }
    } catch (err) {
      // Amendment 4: a bad key or failed load degrades to "no models listed"
      // (parity with a built-in holding a bad key) — the integration above stays.
      console.error(`experiential: skipping provider registration — ${err instanceof Error ? err.message : err}`)
    }

    // 3) refresh (A3/A7): fire-and-forget, guarded against overlap. Re-resolves
    //    the CURRENT credential (a /connect key change never re-runs setup, but
    //    the host re-evaluates the provider catalog on credential change, which
    //    re-invokes the transform, which fires this), loads catalog + models.dev
    //    through the TTL cache (A2: stale-serve on failure, rethrow on first-run
    //    failure so the degrade path keeps integration-without-provider), and
    //    reloads only when what would be registered differs from registeredFp.
    let refreshing = false
    const refresh = async (): Promise<void> => {
      if (refreshing) return
      refreshing = true
      try {
        const nextCred = await resolveCredential(ctx)
        if (!nextCred || !store) return
        let nextConnection: typeof connection
        if (nextCred.via === "connection") {
          try {
            nextConnection = await ctx.integration.connection.active("experiential")
          } catch {
            // transient lookup failure: publish without sourceConnection
          }
        }
        const raw = await loadCatalog(store, nextCred, baseURL)
        const devIndex = await loadModelsDev(store)
        const mapped = mapCatalog(raw, buildEnricher(devIndex))
        if (fingerprint(nextCred, mapped) === registeredFp) return // fixed point: no reload
        cred = nextCred
        connection = nextConnection
        models = mapped
        await ctx.provider.reload()
      } catch (err) {
        console.error(`experiential: refresh failed — ${err instanceof Error ? err.message : err}`)
      } finally {
        refreshing = false
      }
    }

    // 4) Provider (Amendment 3) — sync-only, registers from the closure.
    await ctx.provider.transform((editor) => {
      if (cred && models.length > 0) {
        const info = Provider.Info.empty("experiential")
        // Fix round R1, finding 1: this plugin resolves credentials itself (connection
        // or env), so registration is the activation gate — "auto" would exclude the
        // provider from location catalogs unless the integration has an active
        // connection, and the env credential is invisible to that gate. Parity with
        // config-defined providers.
        info.activation = "enabled"
        info.name = "Experiential"
        info.integrationID = "experiential"
        info.package = "@opencode/ai/providers/openai-compatible"
        info.settings = { baseURL, apiKey: cred.apiKey }
        editor.add({
          info,
          models,
          sourceConnection: cred.via === "connection" ? connection : undefined,
        })
      }
      // Record what this evaluation served the host — even "nothing" — so
      // refresh can tell "unchanged" from "never published".
      registeredFp = cred ? fingerprint(cred, models) : "none"
      void refresh()
    })

    // First boot / TTL-stale cache: fetch in the background and republish.
    void refresh()
  },
})
