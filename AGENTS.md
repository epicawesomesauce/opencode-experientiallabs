# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

An OpenCode V2 plugin (`@opencode/plugin` 2.x) that registers Experiential
Labs (experientiallabs.ai) as a model provider with a dynamic per-account
catalog. Models come from the gateway (`GET /v1/models`) and are enriched
from Experiential's catalog API (`{apiBase}/api/models`) via a slug-exact
join. Package name `opencode-experiential`; plugin/provider id
`experiential`.

## Layout

- `src/index.ts` — plugin entry: `Plugin.define` setup, integration transform
  (registers the `/connect` key-paste method), credential resolution,
  provider registration, TTL refresh + `ctx.provider.reload()`.
- `src/auth.ts` — credential resolution (`/connect` connection wins over the
  `EXPLABS_API_KEY` env fallback).
- `src/catalog.ts` — gateway `/v1/models` → `Model.Info[]` mapping.
- `src/enrich.ts` — display names / vision / release dates from the catalog
  API; `deriveApiBase` (the catalog lives outside the `/v1` surface).
- `src/cache.ts` — TTL caches (catalog 10 min, metadata 24 h), boot-time
  stale-serve, per-key storage.
- `src/types.ts` — shared types.
- `test/` — one `*.test.ts` per module (41 tests).
- `fixtures/` — `experiential-models.json` (captured gateway `/v1/models`)
  and `experiential-catalog.json` (trimmed catalog capture).
- `scripts/trim-experiential-catalog.mjs` — regenerates the trimmed catalog
  fixture from a TEMP capture or a live keyed fetch.
- `assets/` — official Experiential Labs brand marks (© Experiential Labs),
  used unmodified. Do not restyle them.

## Commands

```bash
npm install
npm test     # node --test --experimental-strip-types — needs Node >= 22.6
```

No build step: OpenCode loads `src/index.ts` directly (type stripping) and
bundles its own runtime. Node is only needed to run the test suite.

## Host constraints (discovered the hard way — respect these)

- Integration transform bodies are **sync-only**; never await inside
  `ctx.integration.transform`. Async work happens in `setup` and the refresh
  path instead.
- Registration must never await the network: boot from cache (storage reads
  only), then refresh through the TTL cache and republish with
  `ctx.provider.reload()`.
- `ctx.storage` get/set are async — only call them from async contexts.
- Desktop builds (2.0.24) silently drop local directory paths in the config
  `plugins` array. For local dev use the shim file
  `~/.config/opencode/plugins/experiential.ts` containing
  `export { default } from "file:///<abs-path>/opencode-experientiallabs/src/index.ts"`.
- `EXPLABS_API_KEY` must be visible to the OpenCode **server** process
  (desktop apps inherit user-scoped env vars; the CLI takes the launching
  shell).
- Comments citing internal task numbers (A3/A7/Minor 5) record the reasoning
  behind non-obvious host workarounds — preserve them when editing.

## Rules

- Provider id is `experiential` (not `explabs` — that id is what legacy static
  custom-provider configs used; see the README migration section).
- The `/connect` integration is registered **unconditionally**, before any
  credential exists — that is how users paste the `xpl_` key in the first
  place.
- Failing catalog refreshes serve stale (the provider stays listed, like a
  built-in with a bad key) — never deregister on outage.
- Unmatched models keep their id as display name; enrichment never invents
  metadata.
- No new runtime dependencies without asking — keep `@opencode/plugin` the
  only one.
- Commits: short, lowercase, imperative ("add x", "fix y").

## Related

`epicawesomesauce/explabs-provider-plugin` integrates the same gateway into
Hermes Agent (Python); the gateway API shapes and quirks documented there
apply here too.
