import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { needsFresh } from "./chat.js"
import { readCredential } from "./model.js"

const TAVILY_URL = "https://api.tavily.com/search"
const GOLD_HOSTS = ["sge.com.cn", "cngold.org", "cngold.com.cn", "kitco.com", "gold.org"]
const PRICE = /(\d{2,6}(?:\.\d{1,2})?)\s*(?:元\s*\/\s*克|元每克)/g
const EXCERPT_CAP = 800

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

export function selectResults(results, { fresh, maxResults, gold }) {
  let items = (Array.isArray(results) ? results : [])
    .map(normalizeResult)
    .filter((item) => item.url && isPublicHttpUrl(item.url))
  if (fresh) items = items.filter((item) => !/wikipedia/i.test(item.engine) && !/wikipedia\.org/i.test(item.url))
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
        item.prices.length ? `正文里的数字：${item.prices.join("、")} 元/克` : "正文里没有找到价格数字",
        `正文：${item.excerpt}`,
      ].join("\n")
      : "这条没有正文。不要拿网址编内容，也不能拿它报价格或实时数字。"
    return [head, `网址：${item.url}`, when, body].join("\n")
  })
  if (conflict) lines.push(`两家数字不一致：${conflict}。不要取平均，并列说出来。`)
  lines.push("只使用上面材料里的数字、网址和时间。材料里没有的数字不要编。")
  return lines.join("\n\n")
}

export async function gatherSearch(text, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const fresh = needsFresh(text)
  const gold = /金价|黄金|足金|金条/.test(String(text ?? ""))
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000
  const maxResults = Math.min(5, Number(options.maxResults) > 0 ? Number(options.maxResults) : 5)
  const apiKey = await tavilyKey(options)
  if (!apiKey) return offline("没有 TAVILY_API_KEY")
  const topic = gold ? "finance" : fresh ? "news" : "general"
  const body = {
    query: String(text ?? "").trim(),
    search_depth: "basic",
    chunks_per_source: 2,
    max_results: maxResults,
    topic,
    language: "zh-cn",
    include_answer: false,
    include_raw_content: false,
    include_published_date: true,
  }
  if (fresh) body.time_range = "day"
  if (topic === "general") body.country = "china"
  let payload
  try {
    const response = await fetchImpl(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return offline(response.status === 401 ? "密钥无效" : `HTTP ${response.status}`)
    payload = JSON.parse(await readBody(response))
  } catch (error) {
    return offline(timedOut(error) ? "超时" : "Tavily 未连接")
  }
  const selected = selectResults(payload?.results, { fresh, maxResults, gold })
  const items = selected.map((item) => {
    const excerpt = item.snippet.slice(0, EXCERPT_CAP)
    return { ...item, pageOk: Boolean(excerpt), prices: pricesIn(excerpt), excerpt }
  })
  return formatMaterial(items, priceConflict(items))
}

async function tavilyKey(options) {
  if (options.apiKey) return String(options.apiKey).trim()
  const file = options.credentialsFile ?? path.join(homedir(), ".dsh", ".credentials.yaml")
  try {
    return readCredential(await readFile(file, "utf8"), "TAVILY_API_KEY")
  } catch (error) {
    if (error?.code === "ENOENT") return ""
    throw error
  }
}

function offline(reason) {
  return `搜索没连上（${reason}）。不要编数字，告诉对方这次没查到。`
}

function normalizeResult(item) {
  const url = String(item?.url ?? "").trim()
  const engines = Array.isArray(item?.engines) ? item.engines : []
  const published = item?.published_date ?? item?.publishedDate
  return {
    title: String(item?.title ?? "").trim(),
    url,
    snippet: String(item?.content ?? item?.snippet ?? "").replace(/\s+/g, " ").trim(),
    publishedDate: published ? String(published) : "",
    engine: String(item?.engine ?? engines[0] ?? hostOf(url)).trim(),
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
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

async function readBody(response) {
  if (typeof response.text === "function") return String(await response.text())
  if (typeof response.arrayBuffer === "function") return Buffer.from(await response.arrayBuffer()).toString("utf8")
  return String(response.body ?? "")
}

function timedOut(error) {
  const name = String(error?.name ?? "")
  const message = String(error?.message ?? "")
  return name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(message)
}
