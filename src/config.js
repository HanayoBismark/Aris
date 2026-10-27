import { access, copyFile, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ADMIN_ID } from "./chat.js"

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
      provider: ["deepseek", "qwen"].includes(raw.dsh?.provider) ? raw.dsh.provider : "tokenplan",
    },
    bot: {
      trigger,
      groups: arrayOf(raw.bot?.groups),
      admins: [ADMIN_ID],
      toolPolicy,
      personaFile: path.resolve(root, String(raw.bot?.personaFile ?? "persona/default.md")),
      replyWithQuote: raw.bot?.replyWithQuote !== false,
      maxReplyLength: positive(raw.bot?.maxReplyLength, 1000),
      maxParallel: positive(raw.bot?.maxParallel, 2),
    },
    voice: voiceConfig(raw.voice),
    search: searchConfig(raw.search),
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

function speedFactor(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0.5 || number > 1.5) return 0.85
  return number
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function searchConfig(raw) {
  return {
    enabled: raw?.enabled !== false,
    timeoutMs: positive(raw?.timeoutMs, 20000),
    maxResults: Math.min(5, positive(raw?.maxResults, 5)),
  }
}

function voiceConfig(raw) {
  return {
    enabled: raw?.enabled === true,
    baseUrl: String(raw?.baseUrl ?? "http://127.0.0.1:9880").replace(/\/$/, ""),
    refAudio: String(raw?.refAudio ?? ""),
    promptText: String(raw?.promptText ?? ""),
    promptLang: String(raw?.promptLang ?? "ja"),
    textLang: String(raw?.textLang ?? "zh"),
    gptWeights: String(raw?.gptWeights ?? ""),
    sovitsWeights: String(raw?.sovitsWeights ?? ""),
    speedFactor: speedFactor(raw?.speedFactor),
  }
}
