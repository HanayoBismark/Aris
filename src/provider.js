import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const FILES = {
  tokenplan: "cordis.tokenplan.patch.yml",
  deepseek: "cordis.deepseek.patch.yml",
  qwen: "cordis.qwen.patch.yml",
}

export function providerLabel(provider) {
  if (provider === "deepseek") return "DeepSeek 官方"
  if (provider === "qwen") return "Mac 上的 Qwen"
  return "书生"
}

export async function applyProviderPatch({ root, homeDir, provider }) {
  const name = FILES[provider] ? provider : "tokenplan"
  const source = path.join(root, "migrate", "dsh", "profiles", "acp", FILES[name])
  const text = await readFile(source, "utf8")
  const targets = [
    path.join(root, "migrate", "dsh", "profiles", "acp", "cordis.patch.yml"),
    path.join(homeDir, ".dsh", "profiles", "acp", "cordis.patch.yml"),
  ]
  for (const target of targets) {
    let current = ""
    try {
      current = await readFile(target, "utf8")
    } catch {
      current = ""
    }
    if (current.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n")) continue
    await writeFile(target, text)
  }
  return name
}
