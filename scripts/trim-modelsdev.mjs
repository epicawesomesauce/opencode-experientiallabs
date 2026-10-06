import { existsSync, readFileSync, writeFileSync } from "node:fs"
const cache = `${process.env.TEMP}/modelsdev-full.json`
let full
if (existsSync(cache)) {
  full = JSON.parse(readFileSync(cache, "utf8"))
} else {
  const res = await fetch("https://models.dev/api.json")
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`)
  full = await res.json()
  writeFileSync(cache, JSON.stringify(full))
}
const KEEP = ["anthropic", "azure", "amazon-bedrock", "cerebras", "deepseek", "fireworks-ai",
  "google", "meta", "openai", "openrouter", "alibaba", "google-vertex", "xai", "zai", "zhipuai"]
const out = {}
for (const id of KEEP) if (full[id]) out[id] = full[id]
writeFileSync("fixtures/modelsdev-trimmed.json", JSON.stringify(out, null, 2))
console.log("kept providers:", Object.keys(out).join(", "))
console.log("missing from models.dev:", KEEP.filter((id) => !full[id]).join(", ") || "(none)")
