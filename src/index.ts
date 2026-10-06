import { Plugin, Provider } from "@opencode/plugin"
import type { Model } from "@opencode/plugin"
import { fetchCatalog, mapCatalog } from "./catalog.ts"
import { fetchModelsDev, buildEnricher } from "./enrich.ts"
import { resolveCredential, type Credential } from "./auth.ts"

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

    // 2) Resolve the credential, then live-load the catalog (Ruling 19). All awaits
    //    happen here in setup — transform bodies below are sync-only
    //    (dist/promise/registration.d.ts:12) and read closure variables only.
    //    Task 6 swaps the two load lines for src/cache.ts cached loads.
    let cred: Credential | undefined
    let models: Model.Info[] = []
    let connection: Awaited<ReturnType<typeof ctx.integration.connection.active>> | undefined
    try {
      cred = await resolveCredential(ctx)
      if (cred) {
        // Fix round R1, finding 2: the sourceConnection lookup runs only when the
        // credential came from a connection (env-only setups never call it), and
        // inside this try so a transient rejection degrades to "integration
        // registered, provider skipped" instead of killing setup.
        if (cred.via === "connection") connection = await ctx.integration.connection.active("experiential")
        const raw = await fetchCatalog(baseURL, cred.apiKey)
        const devIndex = await fetchModelsDev()
        const enrich = buildEnricher(devIndex)
        models = mapCatalog(raw, enrich)
      }
    } catch (err) {
      // Amendment 4: a bad key or failed load degrades to "no models listed"
      // (parity with a built-in holding a bad key) — the integration above stays.
      console.error(`experiential: skipping provider registration — ${err instanceof Error ? err.message : err}`)
    }

    // 3) Provider (Amendment 3) — no credential or empty catalog registers nothing.
    await ctx.provider.transform((editor) => {
      if (!cred || models.length === 0) return
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
    })
  },
})
