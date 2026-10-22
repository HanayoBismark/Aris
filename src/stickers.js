import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export class StickerBook {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, "index.json")
    this.items = []
    this.#queue = Promise.resolve()
  }

  #queue

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"))
      this.items = Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.file && item?.name) : []
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      this.items = []
    }
  }

  names() {
    return this.items.map((item) => stickerLabel(item.name)).filter(Boolean)
  }

  find(name) {
    const wanted = stickerLabel(name)
    if (!wanted) return null
    return this.items.find((item) => stickerLabel(item.name) === wanted)
      ?? this.items.find((item) => {
        const label = stickerLabel(item.name)
        return label && (label.includes(wanted) || wanted.includes(label))
      })
      ?? null
  }

  rename(id, name) {
    return this.#update(async () => {
      const item = this.items.find((row) => row.id === id)
      if (!item) return null
      const next = uniqueName(name, this.items.filter((row) => row.id !== id))
      item.name = next
      item.summary = next
      return item
    })
  }

  add(record) {
    return this.#update(async () => {
      await mkdir(this.dir, { recursive: true })
      const name = uniqueName(record.name, this.items)
      const ext = path.extname(record.source) || ".gif"
      const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`
      const dest = path.join(this.dir, `${id}${ext}`)
      await copyFile(record.source, dest)
      const item = {
        id,
        name,
        file: dest,
        summary: String(record.summary ?? ""),
        emojiId: String(record.emojiId ?? ""),
        packageId: String(record.packageId ?? ""),
        key: String(record.key ?? ""),
      }
      this.items.push(item)
      return item
    })
  }

  #update(change) {
    const run = this.#queue.then(async () => {
      const item = await change()
      await mkdir(this.dir, { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(this.items, null, 2), "utf8")
      await rm(this.file, { force: true })
      await rename(temp, this.file)
      return item
    })
    this.#queue = run.then(() => {}, () => {})
    return run
  }
}

const PLACEHOLDER_NAME = /^(?:动画表情|表情包)\d*$|^(?:表情|图片|动画)$/

export function normalizeName(name) {
  return String(name ?? "").replace(/[\\/:*?"<>|\s。！!？?，,]/g, "").slice(0, 16)
}

export function stickerLabel(value) {
  const compact = String(value ?? "").replace(/[\[\]【】\s。！!？?，,]/g, "")
  if (!compact || PLACEHOLDER_NAME.test(compact)) return ""
  return normalizeName(value)
}

function uniqueName(name, items) {
  const base = stickerLabel(name) || `表情${items.length + 1}`
  if (!items.some((item) => item.name === base)) return base
  for (let i = 2; i < 100; i += 1) {
    const next = `${base}${i}`.slice(0, 16)
    if (!items.some((item) => item.name === next)) return next
  }
  return `${base}${Date.now().toString(36)}`.slice(0, 16)
}
