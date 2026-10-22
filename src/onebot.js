import { randomUUID } from "node:crypto"
import { publicWsUrl, withAccessToken } from "./chat.js"

export class OneBotClient {
  constructor({ wsUrl, accessToken, log, webSocket }) {
    this.wsUrl = wsUrl
    this.accessToken = accessToken
    this.log = log
    this.WebSocket = webSocket ?? globalThis.WebSocket
    this.#pending = new Map()
    this.selfId = ""
  }

  #socket
  #pending
  #stopped = false
  #reconnect
  onEvent = () => {}

  start() {
    this.#stopped = false
    this.#connect()
  }

  stop() {
    this.#stopped = true
    clearTimeout(this.#reconnect)
    this.#socket?.close()
  }

  call(action, params, timeoutMs = 10000) {
    if (this.#socket?.readyState !== this.WebSocket.OPEN) {
      return Promise.reject(new Error("NapCat 尚未连接"))
    }
    const echo = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`${action} 超时`))
      }, timeoutMs)
      this.#pending.set(echo, { resolve, reject, timer })
      this.#socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  async sendGroupText(groupId, text, quoteId) {
    const message = []
    if (quoteId !== undefined && quoteId !== null && quoteId !== "") {
      message.push({ type: "reply", data: { id: String(quoteId) } })
    }
    message.push({ type: "text", data: { text } })
    return this.sendGroupSegments(groupId, message)
  }

  async sendGroupSegments(groupId, message) {
    const result = await this.call("send_group_msg", { group_id: qqId(groupId), message })
    return result?.data
  }

  async pokeGroup(groupId, userId) {
    await this.call("group_poke", { group_id: String(groupId), user_id: String(userId) })
  }

  async downloadFile(url, name) {
    const result = await this.call("download_file", { url, name }, 20000)
    return String(result?.data?.file ?? "")
  }

  async fetchCustomFaces(count = 48) {
    const result = await this.call("fetch_custom_face_detail", { count }, 20000)
    return Array.isArray(result?.data) ? result.data : []
  }

  async addCustomFace({ file, emojiId, packageId }) {
    await this.call("add_custom_face", {
      file,
      emoji_id: emojiId || "",
      package_id: packageId === undefined || packageId === "" ? 0 : packageId,
      is_mark_face: Boolean(emojiId),
      is_origin: true,
    }, 20000)
  }

  async react(messageId, emojiId) {
    await this.call("set_msg_emoji_like", {
      message_id: messageId,
      emoji_id: String(emojiId),
      set: true,
    })
  }

  async getMessage(messageId) {
    const result = await this.call("get_msg", { message_id: messageId })
    return result?.data
  }

  #connect() {
    if (this.#stopped) return
    if (typeof this.WebSocket !== "function") {
      throw new Error("当前 Node 没有 WebSocket，请安装 Node.js 22 或更新版本")
    }
    const url = withAccessToken(this.wsUrl, this.accessToken)
    this.log(`正在连接 NapCat ${publicWsUrl(this.wsUrl)}`)
    const socket = new this.WebSocket(url)
    this.#socket = socket
    socket.addEventListener("open", () => {
      this.log("NapCat 已连接")
      this.#identify().catch((error) => this.log(`读取登录信息失败：${error.message}`))
    })
    socket.addEventListener("message", (event) => {
      this.#onMessage(event.data).catch((error) => this.log(`处理 NapCat 消息失败：${error.message}`))
    })
    socket.addEventListener("close", () => {
      this.#rejectPending(new Error("NapCat 连接已断开"))
      if (this.#stopped) return
      this.log("NapCat 连接断开，3 秒后重连")
      this.#reconnect = setTimeout(() => this.#connect(), 3000)
    })
    socket.addEventListener("error", () => {
      this.log("NapCat 连接出错")
    })
  }

  async #identify() {
    const result = await this.call("get_login_info", {})
    const userId = result?.data?.user_id
    if (userId === undefined || userId === null) return
    this.selfId = String(userId)
    this.log(`当前 QQ：${this.selfId}${result.data.nickname ? `（${result.data.nickname}）` : ""}`)
    await this.onReady?.()
  }

  async #onMessage(data) {
    const text = await frameText(data)
    const frame = JSON.parse(text)
    if (frame.echo !== undefined && frame.echo !== null && this.#pending.has(String(frame.echo))) {
      const pending = this.#pending.get(String(frame.echo))
      this.#pending.delete(String(frame.echo))
      clearTimeout(pending.timer)
      if (frame.status === "failed" || (frame.retcode && frame.retcode !== 0)) {
        pending.reject(new Error(frame.wording || frame.message || "OneBot 调用失败"))
      } else {
        pending.resolve(frame)
      }
      return
    }
    if (frame.post_type) this.onEvent(frame)
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

function qqId(value) {
  const text = String(value)
  return /^\d+$/.test(text) ? Number(text) : value
}

async function frameText(data) {
  if (typeof data === "string") return data
  if (typeof data?.text === "function") return data.text()
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
  return String(data)
}
