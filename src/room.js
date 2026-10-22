const LIMIT = 20

export class GroupLog {
  constructor() {
    this.lines = new Map()
  }

  push(groupId, line) {
    const key = String(groupId)
    const list = this.lines.get(key) ?? []
    const replyId = String(line.replyTo ?? "")
    const replied = replyId ? list.find((item) => item.id === replyId) : null
    list.push({
      id: String(line.id ?? ""),
      name: String(line.name ?? "群友"),
      userId: String(line.userId ?? ""),
      text: clip(line.text),
      self: Boolean(line.self),
      replyName: replied ? (replied.self ? "爱丽丝" : replied.name) : "",
      to: String(line.to ?? ""),
    })
    while (list.length > LIMIT) list.shift()
    this.lines.set(key, list)
  }

  recent(groupId, exceptId = "") {
    const skip = String(exceptId ?? "")
    return (this.lines.get(String(groupId)) ?? []).filter((line) => !skip || line.id !== skip)
  }
}

export function formatTranscript(lines, currentIds = "") {
  const list = Array.isArray(lines) ? lines : []
  const current = new Set(
    (Array.isArray(currentIds) ? currentIds : String(currentIds ?? "").split(","))
      .map((id) => String(id ?? "").trim())
      .filter(Boolean),
  )
  let lastCurrent = -1
  list.forEach((line, index) => {
    if (current.has(String(line.id ?? ""))) lastCurrent = index
  })
  const parts = []
  list.forEach((line, index) => {
    if (current.has(String(line.id ?? ""))) return
    const name = line.self ? "爱丽丝" : line.name
    const reply = line.replyName ? `回复${line.replyName}` : ""
    const late = lastCurrent >= 0 && index > lastCurrent ? "（更晚）" : ""
    parts.push(`${name}${reply}${late}：${line.text}`)
  })
  return parts.join("\n") || "（最近没有别的消息）"
}

function clip(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!value) return "…"
  return value.length > 80 ? `${value.slice(0, 79)}…` : value
}
