import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const MEMORY_TURNS = 16
export const MEMORY_CLIP = 120

export function clipLine(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!value) return ""
  if (value.length <= MEMORY_CLIP) return value
  return `${value.slice(0, MEMORY_CLIP - 1)}…`
}

export function formatDialogue(turns, name) {
  const list = Array.isArray(turns) ? turns : []
  if (list.length === 0) return "还没有单独聊过。"
  const who = String(name ?? "").trim() || "对方"
  return list.map((turn) => `${turn.role === "assistant" ? "爱丽丝" : who}：${turn.text}`).join("\n")
}

export class Memory {
  constructor(file) {
    this.file = file
    this.groups = {}
    this.#queue = Promise.resolve()
  }

  #queue

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"))
      this.groups = parsed?.groups && typeof parsed.groups === "object" ? parsed.groups : {}
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      this.groups = {}
    }
  }

  recall(key) {
    const list = this.groups[String(key)]
    return Array.isArray(list) ? list.filter((turn) => turn?.text && (turn.role === "user" || turn.role === "assistant")) : []
  }

  add(key, userText, assistantText) {
    const turns = []
    const user = clipLine(userText)
    const assistant = clipLine(assistantText)
    if (user) turns.push({ role: "user", text: user })
    if (assistant) turns.push({ role: "assistant", text: assistant })
    if (turns.length === 0) return Promise.resolve(this.recall(key))
    return this.#update(() => {
      const id = String(key)
      const next = [...this.recall(id), ...turns].slice(-MEMORY_TURNS)
      this.groups[id] = next
      return next
    })
  }

  delete(key) {
    return this.#update(() => {
      delete this.groups[String(key)]
    })
  }

  #update(change) {
    const run = this.#queue.then(async () => {
      const result = change()
      await mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify({ groups: this.groups }, null, 2), "utf8")
      await rm(this.file, { force: true })
      await rename(temp, this.file)
      return result
    })
    this.#queue = run.then(() => {}, () => {})
    return run
  }
}
