import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { stickerLabel } from "./stickers.js"

const HINTS = {
  "26627A4634750CBAD3B973C0EF8AF849": { name: "委屈冒汗", note: "着急、委屈" },
  FAD78D2214696EA17567EC3D04D72689: { name: "大哭", note: "难过" },
  "342CECE135C376CD448C07700F4F6BAF": { name: "头脑风暴", note: "想不明白" },
  "9C6DC01B696D8B986BF02B7BC96CE64D": { name: "害羞", note: "不好意思" },
  CE506E7373150A897FD7E2B80BF58E88: { name: "快发癫", note: "兴奋、开玩笑" },
  "75BE5F4D94634BE1FC46778AA22E095A": { name: "来做爱", note: "只有对方已经在开这个玩笑时才用" },
  "4E11E5521B7DA20EC8478C86FF4D2C7C": { name: "大佬带带我", note: "拜托、撒娇" },
  "591055D27D3F9B953EC1D0998B5D89A8": { name: "探头", note: "好奇、打招呼" },
  E234DB7200EB5041B97CEFFBAC4F291A: { name: "愣住", note: "惊讶、没听懂" },
  DF44D14A55B247C7650857DB039D087E: { name: "开心挥手", note: "高兴" },
  "9402483FB2F8564550EC1FCAA7C6DC6A": { name: "坐着等", note: "在听、等待" },
  "16D927DF8FD046CC06953F33158B0E7C": { name: "比心", note: "喜欢、谢谢" },
  "16713763DA7BE16EE1B10150C1E76D9E": { name: "抱心", note: "喜欢、害羞" },
}

const FRESH_MS = 10 * 60 * 1000

export class FavFaces {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, "index.json")
    this.items = []
    this.pending = []
    this.unnamed = 0
    this.saved = {}
    this.refreshedAt = 0
    this.#queue = Promise.resolve()
  }

  #queue

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"))
      this.saved = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      this.saved = {}
    }
  }

  stale() {
    return Date.now() - this.refreshedAt > FRESH_MS
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

  promptList(extraNames = []) {
    const rows = this.items
      .filter((item) => stickerLabel(item.name))
      .map((item) => ({ name: item.name, note: item.note }))
    const have = new Set(rows.map((row) => row.name))
    for (const name of extraNames) {
      if (stickerLabel(name) && !have.has(name)) rows.push({ name, note: "另外存的" })
    }
    if (rows.length === 0) return "还没有。这次只说话，不要发小黄脸。"
    return rows.slice(0, 40).map((row) => row.note ? `${row.name}（${row.note}）` : row.name).join("、")
  }

  async refresh(onebot) {
    const list = await onebot.fetchCustomFaces(48)
    const run = this.#queue.then(() => this.#apply(list))
    this.#queue = run.then(() => {}, () => {})
    return run
  }

  async #apply(list) {
    await mkdir(this.dir, { recursive: true })
    const next = []
    const pending = []
    let unnamed = 0
    for (const raw of list ?? []) {
      const md5 = String(raw?.md5 ?? "").toUpperCase()
      if (!/^[0-9A-F]{16,64}$/.test(md5)) continue
      const hint = HINTS[md5] ?? {}
      const saved = this.saved[md5] ?? {}
      const qqName = clean(raw.desc || raw.modifyWord || raw.ocrWord)
      const name = qqName || saved.name || hint.name || ""
      const note = saved.note || hint.note || ""
      if (!name) {
        const file = await this.#ensureFile(raw, md5)
        if (file) pending.push({ md5, file })
        else unnamed += 1
        continue
      }
      const file = await this.#ensureFile(raw, md5)
      if (!file) continue
      this.saved[md5] = { name, note }
      next.push({ md5, name, note, file, summary: name })
    }
    this.items = next
    this.pending = pending
    this.unnamed = unnamed
    this.refreshedAt = Date.now()
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.saved, null, 2), "utf8")
    await rm(this.file, { force: true })
    await rename(temp, this.file)
    return { named: next.length, unnamed, pending: pending.length }
  }

  async namePending(nameOf) {
    const batch = this.pending.splice(0, 4)
    let count = 0
    for (const item of batch) {
      let raw = ""
      try {
        raw = await nameOf(item.file)
      } catch {
        continue
      }
      const name = faceTitle(raw)
      if (!name) continue
      await this.#rememberNamed(item, name)
      count += 1
    }
    return count
  }

  #rememberNamed(item, name) {
    const run = this.#queue.then(async () => {
      this.saved[item.md5] = { name, note: "看图起的" }
      if (!this.items.some((row) => row.md5 === item.md5)) {
        this.items.push({ md5: item.md5, name, note: "看图起的", file: item.file, summary: name })
      }
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(this.saved, null, 2), "utf8")
      await rm(this.file, { force: true })
      await rename(temp, this.file)
    })
    this.#queue = run.then(() => {}, () => {})
    return run
  }

  async #ensureFile(raw, md5) {
    const cached = await existing(this.dir, md5)
    if (cached) return cached
    const url = String(raw?.url ?? "")
    if (!url.startsWith("http")) return ""
    const response = await fetch(url)
    if (!response.ok) return ""
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return ""
    const ext = sniffExt(bytes)
    if (!ext) return ""
    const dest = path.join(this.dir, `${md5}.${ext}`)
    await writeFile(dest, bytes)
    return dest
  }
}

async function existing(dir, md5) {
  for (const ext of ["gif", "png", "jpg", "webp"]) {
    const file = path.join(dir, `${md5}.${ext}`)
    try {
      await access(file)
      return file
    } catch {
      // 继续找下一种后缀。
    }
  }
  return ""
}

export function faceTitle(text) {
  const line = String(text ?? "").split(/\n/).map((part) => part.trim()).find(Boolean) ?? ""
  const name = line.replace(/^名字[:：]?/, "").replace(/[「」"'“”\s。！!？?，,：:、]/g, "").slice(0, 8)
  if (name.length < 2) return ""
  if (/表情|图片|不知道|工具/.test(name)) return ""
  return name
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 16)
}

function sniffExt(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "webp"
  return ""
}
