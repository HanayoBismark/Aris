import { access, copyFile, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
export const root = path.resolve(here, "..")

export async function loadConfig() {
  const example = path.join(root, "config.example.json")
  const file = path.join(root, "config.json")
  try {
    await access(file)
  } catch {
    await copyFile(example, file)
  }
  const raw = JSON.parse(await readFile(file, "utf8"))
  const trigger = raw.bot?.trigger ?? "mention"
  if (trigger !== "mention" && trigger !== "all") {
    throw new Error('bot.trigger 只能是 "mention" 或 "all"')
  }
  const toolPolicy = raw.bot?.toolPolicy ?? "deny"
  if (toolPolicy !== "deny" && toolPolicy !== "allow" && toolPolicy !== "web") {
    throw new Error('bot.toolPolicy 只能是 "deny"、"web" 或 "allow"')
  }
  const command = String(raw.dsh?.command ?? "").trim()
  const args = Array.isArray(raw.dsh?.args) ? raw.dsh.args.map(String) : []
  return {
    file,
    napcat: {
      wsUrl: String(raw.napcat?.wsUrl ?? "ws://127.0.0.1:3001"),
      accessToken: String(raw.napcat?.accessToken ?? ""),
    },
    dsh: {
      command: command || (process.platform === "win32" ? "npx.cmd" : "npx"),
      args: args.length > 0 ? args : ["-y", "@deepseek-ai/dsh", "--profile", "acp"],
      replyTimeoutMs: positive(raw.dsh?.replyTimeoutMs, 180000),
    },
    bot: {
      trigger,
      groups: arrayOf(raw.bot?.groups),
      admins: arrayOf(raw.bot?.admins),
      toolPolicy,
      personaFile: path.resolve(root, String(raw.bot?.personaFile ?? "persona/default.md")),
      replyWithQuote: raw.bot?.replyWithQuote !== false,
      maxReplyLength: positive(raw.bot?.maxReplyLength, 1000),
      maxParallel: positive(raw.bot?.maxParallel, 2),
    },
    workspace: path.join(root, "workspace"),
    storeFile: path.join(root, "data", "sessions.json"),
    noteFile: path.join(root, "data", "notes.json"),
    stickerDir: path.join(root, "data", "stickers"),
    favDir: path.join(root, "data", "fav-faces"),
  }
}

function arrayOf(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
