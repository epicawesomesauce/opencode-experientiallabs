import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import plugin from "../src/index.ts"
import { loadCatalog, loadExperientialCatalog, CATALOG_TTL_MS } from "../src/cache.ts"

// These tests exercise the REAL registered transform callbacks from src/index.ts:
// setup() runs against a structural ctx mock (integration/provider transform
// capture, storage, reload counting), with global fetch mocked to serve the
// repo fixtures. Task 6: setup itself never awaits the network — the sync-only
// transforms register from a closure populated by local reads (credential +
// cache peek), and an async fire-and-forget refresh fetches through the TTL
// cache and republishes via ctx.provider.reload().

const setup = (ctx: unknown) => (plugin as { setup: (ctx: unknown) => Promise<void> }).setup(ctx)

const catalogFixture = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-models.json", import.meta.url), "utf8"),
)
const metaFixture = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-catalog.json", import.meta.url), "utf8"),
)

// Every mock await resolves in microtasks, so one macrotask tick guarantees the
// fire-and-forget refresh chain has fully drained.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const withFixtureFetch = async (run: (fetches: { count: number }) => Promise<void>) => {
  const original = globalThis.fetch
  const fetches = { count: 0 }
  globalThis.fetch = (async (input: unknown) => {
    fetches.count++
    const url = String(input)
    if (url.endsWith("/models")) return jsonResponse(catalogFixture)
    if (url === "https://api.experientiallabs.ai/api/models?limit=1000") return jsonResponse(metaFixture)
    throw new Error(`test: unexpected fetch ${url}`)
  }) as typeof fetch
  try {
    await run(fetches)
  } finally {
    globalThis.fetch = original
  }
}

// Structural ctx mock: captures the transform callbacks; counts active() calls
// (fix-round finding 2 call discipline) and provider reloads; backs storage
// with an in-memory map that tests can share across setups (warm-reboot case).
const mockCtx = (
  opts: { active?: () => unknown; resolve?: (connection: unknown) => unknown; storage?: Map<string, unknown> } = {},
) => {
  const captured: {
    integration: Array<(editor: unknown) => void>
    provider: Array<(editor: unknown) => void>
  } = { integration: [], provider: [] }
  const registration = { dispose: async () => {} }
  const calls = { active: 0, reload: 0 }
  const storage = opts.storage ?? new Map<string, unknown>()
  const ctx = {
    options: {},
    integration: {
      transform: (cb: (editor: unknown) => void) => {
        captured.integration.push(cb)
        return Promise.resolve(registration)
      },
      connection: {
        active: (id: string) => {
          calls.active++
          return opts.active?.(id) ?? undefined
        },
        resolve: (connection: unknown) => opts.resolve?.(connection) ?? undefined,
      },
    },
    provider: {
      transform: (cb: (editor: unknown) => void) => {
        captured.provider.push(cb)
        return Promise.resolve(registration)
      },
      reload: async () => {
        calls.reload++
      },
    },
    // Real ctx.storage get/set are async (dist/promise/storage.d.ts:4-5).
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
  }
  return { ctx, captured, calls, storage }
}

const recordingEditor = () => {
  const added: Array<{ info: Record<string, any>; models: unknown[]; sourceConnection?: unknown }> = []
  // Final fix wave (Minor 4): the integration transform records its editor
  // calls too, so the /connect method payload can be pinned in tests.
  const integrations: Record<string, Record<string, unknown>> = {}
  const methods: Array<Record<string, any>> = []
  return {
    added,
    integrations,
    methods,
    editor: {
      add: (input: { info: unknown; models: unknown[]; sourceConnection?: unknown }) => {
        added.push(input as never)
      },
      update: (id: string, apply: (target: Record<string, unknown>) => void) => {
        integrations[id] = {}
        apply(integrations[id])
      },
      method: {
        update: (payload: Record<string, any>) => {
          methods.push(payload)
        },
      },
    },
  }
}

// A6: the same key format src/cache.ts uses — sha1 slice, never key material.
const cacheKey = (apiKey: string) =>
  `experiential:catalog:${createHash("sha1").update(apiKey).digest("hex").slice(0, 12)}`

test("env credential → provider registered with activation 'enabled', no sourceConnection", async () => {
  process.env.EXPLABS_API_KEY = "env-key"
  try {
    const { ctx, captured, calls, storage } = mockCtx({ active: () => undefined })
    await withFixtureFetch(async (fetches) => {
      await setup(ctx)
      // Task 6 A3 (race fix): setup awaits only local reads — all network
      // fetches happen in the fire-and-forget refresh, never during setup.
      assert.equal(fetches.count, 0, "setup must not await the network")
      await tick()
      assert.equal(fetches.count, 2, "refresh fetches catalog + catalog metadata")
      assert.equal(calls.reload, 1, "first boot: empty closure → refresh republishes via reload")
      assert.equal(captured.integration.length, 1, "integration transform must be registered")
      assert.equal(captured.provider.length, 1, "provider transform must be registered")
      const { added, editor } = recordingEditor()
      captured.provider[0](editor)
      assert.equal(added.length, 1, "refreshed closure → provider add")
      const info = added[0].info
      assert.equal(info.id, "experiential")
      assert.equal(info.name, "Experiential")
      assert.equal(info.integrationID, "experiential")
      assert.equal(info.package, "@opencode/ai/providers/openai-compatible")
      assert.equal(info.settings.baseURL, "https://api.experientiallabs.ai/v1")
      assert.equal(info.settings.apiKey, "env-key")
      // Fix round R1 finding 1: "auto" is gated on an active integration connection,
      // which never exists for env credentials — registration itself is our gate.
      assert.equal(info.activation, "enabled")
      assert.equal(added[0].models.length, 299)
      assert.equal(added[0].sourceConnection, undefined)
      // A6: cached under the sha1-slice key — never the key material itself.
      assert.deepEqual([...storage.keys()].sort(), [cacheKey("env-key"), "experiential:metadata"].sort())
      // Fix round R1 finding 2 (Task 6-adjusted): env credentials never trigger
      // the sourceConnection lookup — every active() call is a resolveCredential
      // probe: 1 in setup + 1 in the post-setup refresh + 1 fired by this
      // transform invocation.
      assert.equal(calls.active, 3)
      // Loop guard (A3 fixed point): the refresh this invocation fired finds a
      // fresh cache and an unchanged fingerprint → no reload, no refetch.
      await tick()
      assert.equal(calls.reload, 1)
      assert.equal(fetches.count, 2)
    })
  } finally {
    delete process.env.EXPLABS_API_KEY
  }
})

test("connection credential → sourceConnection binds the active connection", async () => {
  delete process.env.EXPLABS_API_KEY
  const connection = { type: "credential", id: "conn1", label: "API key", method: "key" }
  const { ctx, captured } = mockCtx({
    active: () => connection,
    resolve: () => ({ type: "key", key: "conn-key" }),
  })
  await withFixtureFetch(async () => {
    await setup(ctx)
    await tick()
    assert.equal(captured.provider.length, 1)
    const { added, editor } = recordingEditor()
    captured.provider[0](editor)
    assert.equal(added.length, 1)
    assert.equal(added[0].info.activation, "enabled")
    assert.equal(added[0].info.settings.apiKey, "conn-key")
    assert.ok(added[0].models.length > 0)
    assert.equal(added[0].sourceConnection, connection)
  })
})

// Final fix wave, Important 1: on reconnect with the SAME API key, the
// (via, keyHash, baseURL, models) fingerprint is identical, so the refresh's
// fixed-point early-return must NOT skip rebinding sourceConnection to the
// NEW connection object the host handed back — the old object is deleted.
test("reconnect with the same key rebinds sourceConnection to the NEW connection", async () => {
  delete process.env.EXPLABS_API_KEY
  const conn1 = { type: "credential", id: "conn1", label: "API key", method: "key" }
  const conn2 = { type: "credential", id: "conn2", label: "API key", method: "key" }
  let current = conn1
  const { ctx, captured, calls } = mockCtx({
    active: () => current,
    resolve: () => ({ type: "key", key: "conn-key" }), // SAME key before and after reconnect
  })
  await withFixtureFetch(async (fetches) => {
    await setup(ctx)
    await tick()
    const r1 = recordingEditor()
    captured.provider[0](r1.editor)
    assert.equal(r1.added.length, 1)
    assert.equal(r1.added[0].sourceConnection, conn1, "baseline: bound to the first connection")
    await tick() // the refresh fired by that invocation converges

    // Disconnect → reconnect: same key, NEW connection object with a DIFFERENT
    // id — only connection identity distinguishes it from the stale state.
    current = conn2
    const stale = recordingEditor()
    captured.provider[0](stale.editor) // host re-evaluates on the credential change
    assert.equal(stale.added[0].sourceConnection, conn1, "still stale until the fired refresh rebinds")
    await tick()
    assert.equal(calls.reload, 2, "identity change must reload even when the fingerprint matches")
    const r3 = recordingEditor()
    captured.provider[0](r3.editor)
    assert.equal(r3.added[0].sourceConnection, conn2, "sourceConnection must follow the new connection object")
    assert.equal(fetches.count, 2, "no refetch — the cached catalog is fresh")
  })
})

test("no credential → integration registered, provider transform adds nothing, no loads", async () => {
  delete process.env.EXPLABS_API_KEY
  const { ctx, captured, calls } = mockCtx({ active: () => undefined })
  const original = globalThis.fetch
  const fetches = { count: 0 }
  globalThis.fetch = (async () => {
    fetches.count++
    throw new Error("test: unexpected network call without credential")
  }) as typeof fetch
  try {
    await setup(ctx)
    await tick() // post-setup refresh: no credential → returns before any load
    assert.equal(captured.integration.length, 1)
    assert.equal(captured.provider.length, 1)
    const { added, editor } = recordingEditor()
    captured.provider[0](editor) // fires a guarded refresh — still no cred, no load
    await tick()
    assert.equal(added.length, 0)
    assert.equal(fetches.count, 0, "no fetch happens without a credential")
    assert.equal(calls.reload, 0)
  } finally {
    globalThis.fetch = original
  }
})

// Final fix wave (Minor 4): pin the integration transform's method payload.
// The /connect API contract {key, answer:{apiKey}} depends on the form field
// key being exactly "apiKey" — a rename here silently breaks key paste.
test("integration transform publishes the /connect key-paste method payload", async () => {
  delete process.env.EXPLABS_API_KEY
  const { ctx, captured } = mockCtx({ active: () => undefined })
  const original = globalThis.fetch
  const fetches = { count: 0 }
  globalThis.fetch = (async () => {
    fetches.count++
    throw new Error("test: unexpected network call")
  }) as typeof fetch
  try {
    await setup(ctx)
    assert.equal(captured.integration.length, 1, "integration transform must be registered")
    const { integrations, methods, editor } = recordingEditor()
    captured.integration[0](editor)
    assert.equal(integrations["experiential"].name, "Experiential")
    assert.equal(methods.length, 1, "exactly one method.update payload")
    const payload = methods[0]
    assert.equal(payload.integrationID, "experiential")
    assert.equal(payload.method.type, "key")
    const form = payload.method.form as Array<Record<string, any>>
    assert.ok(
      form.some((f) => f.key === "apiKey" && f.required === true),
      'the /connect contract depends on a required form field keyed "apiKey"',
    )
    await tick() // post-setup refresh: no credential → returns before any load
    assert.equal(fetches.count, 0, "integration registration is purely local")
  } finally {
    globalThis.fetch = original
  }
})

test("transient active() rejection degrades setup to integration-only; refresh self-heals", async () => {
  delete process.env.EXPLABS_API_KEY
  const connection = { type: "credential", id: "conn1", label: "API key", method: "key" }
  let activeCalls = 0
  const { ctx, captured, calls } = mockCtx({
    active: () => {
      activeCalls++
      if (activeCalls === 2) throw new Error("transient lookup failure") // setup's sourceConnection lookup rejects
      return connection
    },
    resolve: () => ({ type: "key", key: "conn-key" }),
  })
  const errors: string[] = []
  const originalErr = console.error
  console.error = (msg: unknown) => errors.push(String(msg))
  try {
    await withFixtureFetch(async (fetches) => {
      await setup(ctx)
      // A4 contract, pinned directly (fix round R1, I1): "integration registered,
      // provider skipped" — both transforms stay registered; only the add is
      // skipped.
      assert.equal(captured.integration.length, 1, "integration stays registered")
      assert.equal(captured.provider.length, 1, "provider transform stays registered")
      // A4 degrade path preserved: the transient rejection inside setup's try is
      // caught by the single console.error — setup must NOT reject, and the
      // degraded closure registers nothing.
      const degraded = recordingEditor()
      captured.provider[0](degraded.editor) // fires a refresh — guarded (in-flight)
      assert.equal(degraded.added.length, 0, "provider must be skipped when the connection lookup rejects")
      await tick()
      // Task 6: the post-setup refresh re-resolves the credential (the transient
      // failure is gone) and self-heals through reload. Final fix wave (Important
      // 2): the invocation above fired while that refresh was in flight, so its
      // signal is re-run as pending — and because the mock host never
      // re-evaluates the transform on reload, that re-run still sees the stale
      // registeredFp and reloads once more. The next invocation converges.
      assert.equal(fetches.count, 2)
      assert.equal(calls.reload, 2, "self-heal reload + the pending re-run's reload")
      const { added, editor } = recordingEditor()
      captured.provider[0](editor)
      assert.equal(added.length, 1)
      assert.equal(added[0].info.settings.apiKey, "conn-key")
      assert.equal(added[0].sourceConnection, connection)
      assert.ok(added[0].models.length > 0)
      await tick() // the refresh fired by that invocation converges: no reload
      assert.equal(calls.reload, 2)
      assert.equal(fetches.count, 2)
    })
  } finally {
    console.error = originalErr
  }
  // A4: exactly one degrade console.error, from setup's existing catch.
  assert.equal(errors.length, 1)
  assert.match(errors[0], /skipping provider registration/)
})

test("first boot fetches only after setup; warm reboot within TTL registers from the cache with zero fetches", async () => {
  process.env.EXPLABS_API_KEY = "env-key"
  try {
    const shared = new Map<string, unknown>()
    await withFixtureFetch(async (fetches) => {
      // -- first boot: empty cache --
      const first = mockCtx({ active: () => undefined, storage: shared })
      await setup(first.ctx)
      assert.equal(fetches.count, 0, "setup must not await the network (A3 race fix)")
      await tick()
      assert.equal(fetches.count, 2, "the post-setup refresh fetches catalog + metadata once")
      assert.equal(first.calls.reload, 1)
      const r1 = recordingEditor()
      first.captured.provider[0](r1.editor)
      assert.equal(r1.added.length, 1)
      assert.equal(r1.added[0].models.length, 299)
      await tick() // the invocation-fired refresh converges without reloading
      assert.equal(first.calls.reload, 1, "loop guard: no extra reload")

      // -- warm reboot within TTL (plan step 5: the second restart is instant) --
      const second = mockCtx({ active: () => undefined, storage: shared })
      await setup(second.ctx)
      assert.equal(fetches.count, 2, "warm setup reads the cache — still no fetch")
      const r2 = recordingEditor()
      second.captured.provider[0](r2.editor)
      assert.equal(r2.added.length, 1, "the cache peek populates the closure before any refresh")
      assert.equal(r2.added[0].models.length, 299)
      assert.equal(r2.added[0].info.settings.apiKey, "env-key")
      await tick()
      assert.equal(fetches.count, 2, "the refresh fresh-hits the TTL cache — zero new fetches")
      assert.equal(second.calls.reload, 0, "nothing changed → no reload needed")
    })
  } finally {
    delete process.env.EXPLABS_API_KEY
  }
})

test("stale cache still registers models; a failing refetch serves stale again without a reload loop", async () => {
  process.env.EXPLABS_API_KEY = "env-key"
  try {
    const shared = new Map<string, unknown>()
    const storeView = {
      get: async (key: string) => shared.get(key),
      set: async (key: string, value: unknown) => {
        shared.set(key, value)
      },
    }
    // Seed realistic cache entries through the real load paths, then expire the
    // catalog entry past its TTL.
    await withFixtureFetch(async () => {
      await loadCatalog(storeView, { apiKey: "env-key", via: "env" }, "https://api.experientiallabs.ai/v1")
      await loadExperientialCatalog(storeView, "https://api.experientiallabs.ai", "env-key")
    })
    ;(shared.get(cacheKey("env-key")) as { fetchedAt: number }).fetchedAt =
      Date.now() - CATALOG_TTL_MS - 60_000

    const { ctx, captured, calls } = mockCtx({ active: () => undefined, storage: shared })
    const original = globalThis.fetch
    const fetches = { count: 0 }
    globalThis.fetch = (async () => {
      fetches.count++
      throw new Error("test: simulated gateway outage")
    }) as typeof fetch
    try {
      await setup(ctx)
      // Setup registered from the stale cache — no network needed (vanilla
      // parity: models stay listed while the gateway is down).
      const stale = recordingEditor()
      captured.provider[0](stale.editor)
      assert.equal(stale.added.length, 1)
      assert.equal(stale.added[0].models.length, 299)
      await tick()
      // A2: the refresh's refetch fails → the stale cache is re-served; the
      // fingerprint matches what the transform just registered → NO reload
      // (the loop-guard fixed point under persistent failure). Final fix wave
      // (Important 2): the invocation above fired mid-flight, so its signal
      // re-runs as pending — one more refetch attempt, still stale-served.
      assert.equal(fetches.count, 2, "one refetch attempt per refresh run — the pending re-run retries")
      assert.equal(calls.reload, 0)
      // A later host re-evaluation fires another refresh — it must converge
      // the same way instead of reloading forever.
      const again = recordingEditor()
      captured.provider[0](again.editor)
      assert.equal(again.added.length, 1)
      await tick()
      assert.equal(fetches.count, 3, "one attempt per refresh run, still stale-served")
      assert.equal(calls.reload, 0, "loop guard holds under persistent outage")
    } finally {
      globalThis.fetch = original
    }
  } finally {
    delete process.env.EXPLABS_API_KEY
  }
})

test("first boot with empty cache and a gateway outage degrades without a reload", async () => {
  process.env.EXPLABS_API_KEY = "env-key"
  try {
    // No stale-cache seed this time: nothing cached, gateway down from the
    // very first refresh (fix round R1, I2 — mirrors the outage test above
    // without the seed). A2's rethrow must land in refresh's catch, keeping
    // the integration-without-provider degrade and setup resolvable.
    const { ctx, captured, calls } = mockCtx({ active: () => undefined })
    const errors: string[] = []
    const originalErr = console.error
    console.error = (msg: unknown) => errors.push(String(msg))
    const original = globalThis.fetch
    const fetches = { count: 0 }
    globalThis.fetch = (async () => {
      fetches.count++
      throw new Error("test: simulated gateway outage")
    }) as typeof fetch
    try {
      await setup(ctx) // must resolve — the fetch failure never reaches setup
      const { added, editor } = recordingEditor()
      captured.provider[0](editor) // fires a refresh while one is in flight (pending signal)
      assert.equal(added.length, 0, "first-boot outage registers nothing")
      await tick()
      assert.equal(calls.reload, 0, "nothing loaded → nothing to publish → no reload")
      assert.equal(fetches.count, 2, "post-setup refresh + the pending re-run both attempt once")
    } finally {
      globalThis.fetch = original
      console.error = originalErr
    }
    // Final fix wave (Important 2): the mid-flight signal is never dropped —
    // the pending re-run retries the failed fetch and reports it too. Both
    // console.errors are refresh failures; setup stayed clean.
    assert.equal(errors.length, 2)
    assert.match(errors[0], /refresh failed/)
    assert.match(errors[1], /refresh failed/)
  } finally {
    delete process.env.EXPLABS_API_KEY
  }
})

// Final fix wave, Important 2: a credential change landing inside an in-flight
// refresh window must not be dropped. The transform evaluation fired while the
// post-setup refresh is parked on a slow fetch has to leave a pending signal
// that re-runs refresh once the in-flight one completes.
test("a credential change landing inside an in-flight refresh is re-run, not dropped", async () => {
  process.env.EXPLABS_API_KEY = "env-key-1"
  try {
    const { ctx, captured, calls } = mockCtx({ active: () => undefined })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const original = globalThis.fetch
    const fetches = { count: 0 }
    globalThis.fetch = (async (input: unknown) => {
      fetches.count++
      const url = String(input)
      if (url.endsWith("/models")) {
        await gate // slow catalog fetch keeps the post-setup refresh in flight
        return jsonResponse(catalogFixture)
      }
      if (url === "https://api.experientiallabs.ai/api/models?limit=1000") return jsonResponse(metaFixture)
      throw new Error(`test: unexpected fetch ${url}`)
    }) as typeof fetch
    try {
      await setup(ctx) // post-setup refresh starts and parks on the gate
      // Credential change lands INSIDE the in-flight window...
      process.env.EXPLABS_API_KEY = "env-key-2"
      // ...and the host re-evaluates the provider catalog for it.
      const r1 = recordingEditor()
      captured.provider[0](r1.editor) // fires a refresh while one is in flight
      release() // the slow fetch resolves; the in-flight refresh completes
      await tick()
      assert.equal(calls.reload, 2, "the pending re-run must republish the new credential")
      assert.equal(fetches.count, 3, "catalog (key1) + metadata + catalog (key2)")
      const r2 = recordingEditor()
      captured.provider[0](r2.editor)
      assert.equal(r2.added.length, 1)
      assert.equal(r2.added[0].info.settings.apiKey, "env-key-2", "the mid-flight credential change must land")
    } finally {
      globalThis.fetch = original
    }
  } finally {
    delete process.env.EXPLABS_API_KEY
  }
})
