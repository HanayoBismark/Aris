import { spawn } from "node:child_process"
import { choosePermission } from "./chat.js"

export class AcpClient {
  constructor({ command, args, cwd, toolPolicy, replyTimeoutMs, log, spawnProcess }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.toolPolicy = toolPolicy
    this.replyTimeoutMs = replyTimeoutMs
    this.log = log
    this.spawnProcess = spawnProcess ?? defaultSpawn
    this.#pending = new Map()
    this.#permissions = new Map()
    this.#updates = new Set()
    this.#active = new Set()
    this.#toolNames = new Map()
    this.#nextId = 0
    this.#buffer = ""
  }

  #child
  #pending
  #permissions
  #updates
  #active
  #toolNames
  #nextId
  #buffer
  #ready

  start() {
    if (!this.#ready) {
      this.#ready = this.#boot().catch((error) => {
        this.#ready = null
        this.#child?.kill()
        throw error
      })
    }
    return this.#ready
  }

  async #boot() {
    this.#child = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.#child.stdout.on("data", (chunk) => this.#push(chunk.toString("utf8")))
    this.#child.stderr.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim()
      if (line) this.log(`dsh: ${line}`)
    })
    this.#child.on("exit", (code, signal) => {
      const error = new Error(`dsh 已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`)
      this.#active.clear()
      this.#failAll(error)
      this.#ready = null
      this.#child = null
    })
    const hello = await this.#request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "napcat-dsh-bot", version: "0.1.0" },
    }, 180000)
    this.log(`dsh 已连接：${hello?.agentInfo?.name ?? "deepseek-harness-acp"}`)
  }

  async createSession(cwd) {
    await this.start()
    const created = await this.#request("session/new", { cwd, mcpServers: [] }, 180000)
    this.#active.add(created.sessionId)
    return created.sessionId
  }

  async resumeSession(sessionId, cwd) {
    await this.start()
    if (this.#active.has(sessionId)) return
    await this.#request("session/resume", { sessionId, cwd, mcpServers: [] }, 180000)
    this.#active.add(sessionId)
  }

  async closeSession(sessionId, cwd) {
    await this.start()
    if (!this.#active.has(sessionId)) {
      try {
        await this.#request("session/resume", { sessionId, cwd, mcpServers: [] }, 180000)
        this.#active.add(sessionId)
      } catch {
        return
      }
    }
    await this.#request("session/close", { sessionId }, 30000)
    this.#active.delete(sessionId)
  }

  async prompt(sessionId, content) {
    await this.start()
    let chunks = ""
    const onUpdate = (params) => {
      if (String(params?.sessionId ?? "") !== String(sessionId)) return
      chunks += assistantText(params.update ?? params)
    }
    this.#updates.add(onUpdate)
    const prompt = typeof content === "string" ? [{ type: "text", text: content }] : content
    try {
      const result = await this.#request("session/prompt", {
        sessionId,
        prompt,
      }, this.replyTimeoutMs)
      return { text: chunks, stopReason: result?.stopReason ?? "" }
    } catch (error) {
      try {
        this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
        this.#cancelPermissions(sessionId)
      } catch {
        // 进程已经退出时，取消通知送不出去。
      }
      throw error
    } finally {
      this.#updates.delete(onUpdate)
    }
  }

  async stop() {
    const child = this.#child
    this.#ready = null
    this.#child = null
    if (!child) return
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
    } else {
      child.kill()
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      child.once?.("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  #push(text) {
    this.#buffer += text
    let newline = this.#buffer.indexOf("\n")
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line) this.#onLine(line)
      newline = this.#buffer.indexOf("\n")
    }
  }

  #onLine(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.log(`dsh 输出了无法解析的内容：${line.slice(0, 200)}`)
      return
    }
    if (frame.method === "session/update") {
      const update = frame.params?.update ?? frame.params
      if (update?.sessionUpdate === "tool_call" && update.toolCallId) {
        this.#toolNames.set(String(update.toolCallId), String(update.title ?? ""))
      }
      for (const listener of this.#updates) listener(frame.params)
      return
    }
    if (frame.method === "session/request_permission" && frame.id !== undefined) {
      this.#permissions.set(frame.id, frame.params?.sessionId)
      const callId = frame.params?.toolCall?.toolCallId
      const toolName = this.#toolNames.get(String(callId ?? ""))
      const result = choosePermission(frame.params, this.toolPolicy, toolName)
      this.#permissions.delete(frame.id)
      this.#send({ jsonrpc: "2.0", id: frame.id, result })
      const optionId = result.outcome?.optionId ?? "cancelled"
      this.log(`已${optionId === "allow-once" ? "允许" : "拒绝"}工具 ${toolName || "未知"}`)
      return
    }
    if (frame.id !== undefined && frame.method) {
      this.#send({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: `未实现的客户端方法：${frame.method}` },
      })
      return
    }
    if (frame.id === undefined) return
    const pending = this.#pending.get(frame.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(frame.id)
    if (frame.error) pending.reject(new Error(frame.error.message || "dsh 请求失败"))
    else pending.resolve(frame.result)
  }

  #request(method, params, timeoutMs) {
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#send({ jsonrpc: "2.0", id, method, params })
    })
  }

  #send(frame) {
    if (!this.#child?.stdin.writable) throw new Error("dsh 进程不可写")
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  #cancelPermissions(sessionId) {
    for (const [id, owner] of this.#permissions) {
      if (String(owner) !== String(sessionId)) continue
      this.#permissions.delete(id)
      this.#send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } })
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

function assistantText(update) {
  if (update?.sessionUpdate !== "agent_message_chunk") return ""
  const content = update.content
  if (content?.type === "text") return String(content.text ?? "")
  if (typeof content === "string") return content
  return ""
}

function defaultSpawn(command, args, options) {
  return spawn(command, args, options)
}
