import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import plugin from "../src/index.ts"

// These tests exercise the REAL registered transform callbacks from src/index.ts:
// setup() runs against a structural ctx mock (integration/provider transform capture),
// with global fetch mocked to serve the repo fixtures so the live-load path
// ("Task 6 swaps the two load lines") runs against real captured data.

const setup = (ctx: unknown) => (plugin as { setup: (ctx: unknown) => Promise<void> }).setup(ctx)

const catalogFixture = JSON.parse(
  readFileSync(new URL("../fixtures/experiential-models.json", import.meta.url), "utf8"),
)
const modelsDevFixture = JSON.parse(
  readFileSync(new URL("../fixtures/modelsdev-trimmed.json", import.meta.url), "utf8"),
)

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const withFixtureFetch = async (run: () => Promise<void>) => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.endsWith("/models")) return jsonResponse(catalogFixture)
    if (url === "https://models.dev/api.json") return jsonResponse(modelsDevFixture)
    throw new Error(`test: unexpected fetch ${url}`)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

// Structural ctx mock: captures the transform callbacks; counts active() calls so
// tests can pin the fix-round finding 2 call discipline.
const mockCtx = (opts: { active?: () => unknown; resolve?: (connection: unknown) => unknown } = {}) => {
  const captured: {
    integration: Array<(editor: unknown) => void>
    provider: Array<(editor: unknown) => void>
  } = { integration: [], provider: [] }
  const registration = { dispose: async () => {} }
  const calls = { active: 0 }
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
    },
  }
  return { ctx, captured, calls }
}

const recordingEditor = () => {
  const added: Array<{ info: Record<string, any>; models: unknown[]; sourceConnection?: unknown }> = []
  return {
    added,
    editor: {
      add: (input: { info: unknown; models: unknown[]; sourceConnection?: unknown }) => {
        added.push(input as never)
      },
    },
  }
}

test("env credential → provider registered with activation 'enabled', no sourceConnection", async () => {
  process.env.EXPLABS_API_KEY = "env-key"
  try {
    const { ctx, captured, calls } = mockCtx({ active: () => undefined })
    await withFixtureFetch(() => setup(ctx))
    assert.equal(captured.integration.length, 1, "integration transform must be registered")
    assert.equal(captured.provider.length, 1, "provider transform must be registered")
    const { added, editor } = recordingEditor()
    captured.provider[0](editor)
    assert.equal(added.length, 1, "env credential + catalog → provider add")
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
    // Fix round R1 finding 2: env-only setups probe for a connection once
    // (resolveCredential) and never make the sourceConnection lookup.
    assert.equal(calls.active, 1)
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
  await withFixtureFetch(() => setup(ctx))
  assert.equal(captured.provider.length, 1)
  const { added, editor } = recordingEditor()
  captured.provider[0](editor)
  assert.equal(added.length, 1)
  assert.equal(added[0].info.activation, "enabled")
  assert.equal(added[0].info.settings.apiKey, "conn-key")
  assert.ok(added[0].models.length > 0)
  assert.equal(added[0].sourceConnection, connection)
})

test("no credential → integration registered, provider transform adds nothing, no loads", async () => {
  delete process.env.EXPLABS_API_KEY
  const { ctx, captured } = mockCtx({ active: () => undefined })
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("test: unexpected network call without credential")
  }) as typeof fetch
  try {
    await setup(ctx)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(captured.integration.length, 1)
  assert.equal(captured.provider.length, 1)
  const { added, editor } = recordingEditor()
  captured.provider[0](editor)
  assert.equal(added.length, 0)
})

test("transient active() rejection during sourceConnection lookup degrades to integration-only", async () => {
  delete process.env.EXPLABS_API_KEY
  const connection = { type: "credential", id: "conn1", label: "API key", method: "key" }
  let activeCalls = 0
  const { ctx, captured } = mockCtx({
    active: () => {
      activeCalls++
      if (activeCalls === 1) return connection // resolveCredential's probe succeeds
      throw new Error("transient lookup failure") // setup's sourceConnection lookup rejects
    },
    resolve: () => ({ type: "key", key: "conn-key" }),
  })
  // Fix round R1 finding 2: the rejection must be caught by the existing
  // degrade-to-integration path — setup must NOT reject.
  await withFixtureFetch(() => setup(ctx))
  assert.equal(captured.integration.length, 1)
  assert.equal(captured.provider.length, 1)
  const { added, editor } = recordingEditor()
  captured.provider[0](editor)
  assert.equal(added.length, 0, "provider must be skipped when the connection lookup rejects")
})
