import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveCredential } from "../src/auth.ts"

// Amendment 1: resolveCredential is async — real API is
// active: (integrationID) => Promise<ConnectionInfo | undefined> and
// resolve: (connection) => Promise<Credential.Value | undefined>
// (dist/promise/integration.d.ts:75-77), so the mocks return promises too.

// The resolve() mock returns the REAL key-variant of Credential.Value
// (@opencode/schema/dist/credential.d.ts:178-191) — not the plan's bare string.
const keyCredential = (key: string) => ({ type: "key" as const, key })

// ConnectionInfo credential variant (client generated types: ConnectionCredentialInfo).
const connection = { type: "credential", id: "conn1", label: "API key", method: "key" }

const ctxWith = (resolve: (conn: unknown) => unknown, active: () => unknown = () => connection) => ({
  integration: { connection: { active, resolve } },
})

test("connection wins over env", async () => {
  process.env.EXPLABS_API_KEY = "env-key"
  try {
    const cred = await resolveCredential(ctxWith(async () => keyCredential("conn-key")))
    assert.equal(cred!.apiKey, "conn-key")
    assert.equal(cred!.via, "connection")
  } finally {
    delete process.env.EXPLABS_API_KEY
  }
})

test("env fallback when no connection", async () => {
  process.env.EXPLABS_API_KEY = "env-key"
  try {
    const cred = await resolveCredential(
      ctxWith(async () => keyCredential("never"), () => undefined),
    )
    assert.equal(cred!.apiKey, "env-key")
    assert.equal(cred!.via, "env")
  } finally {
    delete process.env.EXPLABS_API_KEY
  }
})

test("no credential", async () => {
  delete process.env.EXPLABS_API_KEY
  const cred = await resolveCredential(ctxWith(async () => keyCredential("never"), () => undefined))
  assert.equal(cred, undefined)
})
