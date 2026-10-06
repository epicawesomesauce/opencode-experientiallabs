import type { Credential as CredentialValue } from "@opencode/plugin"

// The resolved credential: the API key plus where it came from.
export interface Credential {
  apiKey: string
  via: "connection" | "env"
}

// Minimal structural slice of the plugin context so unit tests can mock it
// without a real server. Real signatures (dist/promise/integration.d.ts:75-77):
//   active: (integrationID: string) => Promise<ConnectionInfo | undefined>
//   resolve: (connection: ConnectionInfo) => Promise<Credential.Value | undefined>
// The `unknown`s keep mocks trivial; resolveCredential awaits regardless
// (await works on non-promises too).
export interface PluginContextLike {
  integration: {
    connection: {
      active: (integrationID: string) => unknown
      resolve: (connection: unknown) => unknown
    }
  }
}

// Amendment 1: async because both real lookups return promises.
export async function resolveCredential(ctx: PluginContextLike): Promise<Credential | undefined> {
  const connection = await ctx.integration.connection.active("experiential")
  if (connection) {
    // Credential.Value union (@opencode/schema/dist/credential.d.ts:178-191):
    // oauth | key — only the "key" variant carries .key.
    const value = (await ctx.integration.connection.resolve(connection)) as
      | CredentialValue.Value
      | undefined
    if (value?.type === "key" && value.key) return { apiKey: value.key, via: "connection" }
  }
  const env = process.env.EXPLABS_API_KEY
  if (env) return { apiKey: env, via: "env" }
  return undefined
}
