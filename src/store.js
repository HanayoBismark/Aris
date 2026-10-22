import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export class SessionStore {
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

  get(groupId) {
    return this.groups[String(groupId)] ?? null
  }

  set(groupId, record) {
    return this.#update(() => {
      this.groups[String(groupId)] = record
    })
  }

  delete(groupId) {
    return this.#update(() => {
      delete this.groups[String(groupId)]
    })
  }

  #update(change) {
    const run = this.#queue.then(async () => {
      change()
      await mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify({ groups: this.groups }, null, 2), "utf8")
      await rm(this.file, { force: true })
      await rename(temp, this.file)
    })
    this.#queue = run.then(() => {}, () => {})
    return run
  }
}
