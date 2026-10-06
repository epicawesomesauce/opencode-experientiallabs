import { readFileSync, writeFileSync } from "node:fs"
const full = JSON.parse(readFileSync(`${process.env.TEMP}/modelsdev-full.json`, "utf8"))
const KEEP = ["anthropic", "azure", "bedrock", "cerebras", "deepseek", "fireworks",
  "google", "meta", "openai", "openrouter", "qwen", "vertex", "xai", "zai", "zhipuai"]
const out = {}
for (const id of KEEP) if (full[id]) out[id] = full[id]
writeFileSync("fixtures/modelsdev-trimmed.json", JSON.stringify(out, null, 2))
console.log("kept providers:", Object.keys(out).join(", "))
