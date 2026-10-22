import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const LIMIT = 24

export class Notebook {
  constructor(file) {
    this.file = file
    this.groups = {}
    this.#queue = Promise.resolve()
  }

  #queue

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"))
      this.groups = parsed && typeof parsed === "object" ? parsed : {}
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      this.groups = {}
    }
  }

  notes(groupId) {
    const list = this.groups[String(groupId)]
    return Array.isArray(list) ? list.map(String) : []
  }

  add(groupId, notes) {
    const incoming = [...new Set((notes ?? []).map(clean).filter(Boolean))]
    if (incoming.length === 0) return Promise.resolve([])
    return this.#update(() => {
      const key = String(groupId)
      const current = this.notes(key)
      const next = [...current]
      const added = []
      for (const note of incoming) {
        if (next.includes(note)) continue
        next.push(note)
        added.push(note)
      }
      this.groups[key] = next.slice(-LIMIT)
      return added
    })
  }

  #update(change) {
    const run = this.#queue.then(async () => {
      const added = change()
      await mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(this.groups, null, 2), "utf8")
      await rm(this.file, { force: true })
      await rename(temp, this.file)
      return added
    })
    this.#queue = run.then(() => {}, () => {})
    return run
  }
}

function clean(note) {
  return String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 40)
}
