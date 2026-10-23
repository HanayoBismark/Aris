import { needsFresh } from "./chat.js"

const GOLD_HOSTS = ["sge.com.cn", "cngold.org", "cngold.com.cn", "kitco.com", "gold.org"]
const PRICE = /(\d{2,6}(?:\.\d{1,2})?)\s*(?:元\s*\/\s*克|元每克)/g
const PAGE_CAP = 120000
const EXCERPT_CAP = 300

export function isPublicHttpUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false
  if (host === "::1" || host === "0.0.0.0") return false
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return false
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!v4) return true
  const parts = v4.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127 || a === 255) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  return true
}

export function isGoldHost(value) {
  let host
  try {
    host = new URL(String(value)).hostname.toLowerCase()
  } catch {
    return false
  }
  return GOLD_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))
}

export function shanghaiDay(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

export function selectResults(results, { fresh, now, maxResults, gold }) {
  let items = (Array.isArray(results) ? results : [])
    .map(normalizeResult)
    .filter((item) => item.url && isPublicHttpUrl(item.url))
  if (fresh) {
    items = items.filter((item) => !/wikipedia/i.test(item.engine) && !/wikipedia\.org/i.test(item.url))
    const today = shanghaiDay(now)
    const datedToday = items.filter((item) => item.publishedDate && sameDay(item.publishedDate, today))
    if (datedToday.length > 0) items = datedToday
  }
  if (gold) items.sort((a, b) => Number(isGoldHost(b.url)) - Number(isGoldHost(a.url)))
  return items.slice(0, maxResults)
}

export function pricesIn(text) {
  return [...new Set([...String(text ?? "").matchAll(PRICE)].map((match) => match[1]))]
}

export function formatMaterial(items, conflict) {
  if (!items.length) return "查过了，没有可用结果。不要编数字，告诉对方没查到。"
  const lines = items.map((item, index) => {
    const head = `${index + 1}. [${item.engine || "未知"}] ${item.title || "无标题"}`
    const when = `时间：${item.publishedDate || "没有时间"}`
    const body = item.pageOk
      ? [
        item.prices.length ? `页面正文里的数字：${item.prices.join("、")} 元/克` : "页面正文里没有找到价格数字",
        item.excerpt ? `页面摘录：${item.excerpt}` : "",
      ].filter(Boolean).join("\n")
      : `摘要：${item.snippet || "没有"}（未核实，不能单独拿来报价格或实时数字）`
    return [head, `网址：${item.url}`, when, body].join("\n")
  })
  if (conflict) lines.push(`两家数字不一致：${conflict}。不要取平均，并列说出来。`)
  lines.push("只使用上面材料里的数字、网址和时间。材料里没有的数字不要编。")
  return lines.join("\n\n")
}

export async function gatherSearch(text, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now instanceof Date ? options.now : new Date()
  const fresh = needsFresh(text)
  const gold = /金价|黄金|足金|金条/.test(String(text ?? ""))
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000
  const maxResults = Number(options.maxResults) > 0 ? Number(options.maxResults) : 5
  const fetchPages = Math.min(2, Number(options.fetchPages) > 0 ? Number(options.fetchPages) : 2)
  let payload
  try {
    const endpoint = new URL("/search", options.searxngUrl || "http://127.0.0.1:8088")
    endpoint.searchParams.set("q", fresh ? `${String(text).trim()} ${shanghaiDay(now)}` : String(text).trim())
    endpoint.searchParams.set("format", "json")
    endpoint.searchParams.set("language", "zh-CN")
    if (fresh) endpoint.searchParams.set("time_range", "day")
    const response = await fetchImpl(endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1" },
    })
    if (!response.ok) return offline(`HTTP ${response.status}`)
    payload = JSON.parse(await readBody(response))
  } catch (error) {
    return offline(timedOut(error) ? "超时" : "本机搜索服务未连接")
  }
  const selected = selectResults(payload?.results, { fresh, now, maxResults, gold })
  const items = []
  for (const [index, item] of selected.entries()) {
    if (index >= fetchPages) {
      items.push({ ...item, pageOk: false, prices: [], excerpt: "" })
      continue
    }
    const page = await readPage(item.url, fetchImpl, Math.min(8000, timeoutMs))
    const prices = page.ok ? pricesIn(page.text) : []
    items.push({
      ...item,
      pageOk: page.ok,
      prices,
      excerpt: page.ok ? page.text.slice(0, EXCERPT_CAP) : "",
    })
  }
  return formatMaterial(items, priceConflict(items))
}

function offline(reason) {
  return `搜索没连上（${reason}）。不要编数字，告诉对方这次没查到。`
}

function normalizeResult(item) {
  const engines = Array.isArray(item?.engines) ? item.engines : []
  return {
    title: String(item?.title ?? "").trim(),
    url: String(item?.url ?? "").trim(),
    snippet: String(item?.content ?? item?.snippet ?? "").replace(/\s+/g, " ").trim(),
    publishedDate: item?.publishedDate ? String(item.publishedDate) : "",
    engine: String(item?.engine ?? engines[0] ?? "").trim(),
  }
}

function sameDay(value, today) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return shanghaiDay(date) === today
}

function priceConflict(items) {
  const byEngine = new Map()
  for (const item of items) {
    if (!item.pageOk || item.prices.length === 0) continue
    const key = item.engine || item.url
    const prices = byEngine.get(key) ?? new Set()
    for (const price of item.prices) prices.add(price)
    byEngine.set(key, prices)
  }
  const groups = [...byEngine.entries()]
  if (groups.length < 2) return ""
  const shared = [...groups[0][1]].some((price) => groups.slice(1).every(([, prices]) => prices.has(price)))
  if (shared) return ""
  return groups.map(([name, prices]) => `${name} ${[...prices].join("、")}`).join("；")
}

async function readPage(url, fetchImpl, timeoutMs) {
  let current = url
  for (let hop = 0; hop < 2; hop += 1) {
    if (!isPublicHttpUrl(current)) return { ok: false, text: "" }
    let response
    try {
      response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      return { ok: false, text: "" }
    }
    const status = Number(response.status)
    if (status >= 300 && status < 400) {
      const location = header(response, "location")
      if (!location) return { ok: false, text: "" }
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok) return { ok: false, text: "" }
    const type = header(response, "content-type")
    if (type && !/text|html|json|xml/i.test(type)) return { ok: false, text: "" }
    const raw = await readBody(response)
    return { ok: true, text: htmlToText(raw.slice(0, PAGE_CAP)) }
  }
  return { ok: false, text: "" }
}

function header(response, name) {
  const headers = response?.headers
  if (!headers) return ""
  if (typeof headers.get === "function") return String(headers.get(name) ?? "")
  return String(headers[name] ?? headers[name.toLowerCase()] ?? "")
}

async function readBody(response) {
  if (typeof response.text === "function") return String(await response.text())
  if (typeof response.arrayBuffer === "function") return Buffer.from(await response.arrayBuffer()).toString("utf8")
  return String(response.body ?? "")
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim()
}

function timedOut(error) {
  const name = String(error?.name ?? "")
  const message = String(error?.message ?? "")
  return name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(message)
}
