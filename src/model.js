import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const ENDPOINTS = {
  qwen: {
    baseURL: "http://127.0.0.1:18080/v1",
    model: "/Users/ljw/Aris/models/Qwen3.5-122B-A10B-6bit",
    apiKeyEnv: "QWEN_API_KEY",
    maxTokens: 2048,
  },
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    maxTokens: 2048,
  },
  tokenplan: {
    baseURL: "https://discovery-api.intern-ai.org.cn/v1",
    model: "deepseek-v4.1-flash-1017",
    apiKeyEnv: "TOKENPLAN_API_KEY",
    maxTokens: 4096,
  },
}

export function endpointFor(provider) {
  return ENDPOINTS[provider] ?? ENDPOINTS.tokenplan
}

export function readCredential(text, name) {
  const match = String(text ?? "").match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, "m"))
  return match?.[1] ?? ""
}

export function toContent(content) {
  if (typeof content === "string") return content
  return (Array.isArray(content) ? content : []).map((part) => {
    if (part?.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      }
    }
    return { type: "text", text: String(part?.text ?? "") }
  })
}

export function deltaFromLine(line) {
  const trimmed = String(line ?? "").trim()
  if (!trimmed.startsWith("data:")) return ""
  const data = trimmed.slice(5).trim()
  if (!data || data === "[DONE]") return ""
  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    return ""
  }
  const content = parsed?.choices?.[0]?.delta?.content
  return typeof content === "string" ? content : ""
}

export class ModelClient {
  constructor({ provider, replyTimeoutMs, log, fetchImpl, credentialsFile }) {
    this.endpoint = endpointFor(provider)
    this.replyTimeoutMs = replyTimeoutMs
    this.log = log ?? (() => {})
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.credentialsFile = credentialsFile ?? path.join(homedir(), ".dsh", ".credentials.yaml")
    this.#inflight = new Map()
    this.#keyText = null
  }

  #inflight
  #keyText

  activeKeys() {
    return [...this.#inflight.keys()]
  }

  async complete(key, content) {
    const id = String(key ?? "")
    const controller = new AbortController()
    this.#inflight.set(id, controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.replyTimeoutMs)
    const started = Date.now()
    let ttftMs = 0
    try {
      const apiKey = await this.#apiKey()
      const response = await this.fetchImpl(`${this.endpoint.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.endpoint.model,
          messages: [{ role: "user", content: toContent(content) }],
          max_tokens: this.endpoint.maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`模型接口 ${response.status} ${detail.slice(0, 180)}`)
      }
      let text = ""
      for await (const delta of readDeltas(response.body)) {
        if (!ttftMs) ttftMs = Date.now() - started
        text += delta
      }
      return { text, ttftMs, elapsedMs: Date.now() - started }
    } catch (error) {
      if (timedOut) throw new Error("超时")
      if (error?.name === "AbortError" || controller.signal.aborted) throw new Error("已取消")
      throw error
    } finally {
      clearTimeout(timer)
      if (this.#inflight.get(id) === controller) this.#inflight.delete(id)
    }
  }

  cancel(key) {
    this.#inflight.get(String(key ?? ""))?.abort()
  }

  cancelAll() {
    for (const controller of this.#inflight.values()) controller.abort()
  }

  async #apiKey() {
    const fromEnv = process.env[this.endpoint.apiKeyEnv]
    if (fromEnv) return fromEnv
    if (this.#keyText === null) {
      try {
        this.#keyText = await readFile(this.credentialsFile, "utf8")
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        this.#keyText = ""
      }
    }
    const value = readCredential(this.#keyText, this.endpoint.apiKeyEnv)
    if (value) return value
    if (this.endpoint.apiKeyEnv === "QWEN_API_KEY") return "local"
    throw new Error(`没有找到 ${this.endpoint.apiKeyEnv}`)
  }
}

async function* readDeltas(body) {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ""
    for (const line of parts) {
      const delta = deltaFromLine(line)
      if (delta) yield delta
    }
  }
  const last = deltaFromLine(buffer)
  if (last) yield last
}
