import { spawn } from "node:child_process"
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { ModelClient } from "./model.js"
import { addressMode, ADMIN_ID, BOT_CLOSING, buildLingerPrompt, buildPrompt, callsHer, decide, isReusableSticker, listedBotTurn, mergeBurst, messageMedia, namesSomeoneElse, needsSearch, parseApiChoice, parseBotList, parseOutgoing, planVoice, quietOrder, shouldCarryImage, splitBubbles, stickerUrl, stopTargets, takeAsides, threadKey } from "./chat.js"
import { gatherSearch } from "./search.js"
import { loadConfig, root } from "./config.js"
import { formatDialogue, Memory } from "./memory.js"
import { Notebook } from "./notebook.js"
import { OneBotClient } from "./onebot.js"
import { formatTranscript, GroupLog } from "./room.js"
import { SessionStore } from "./store.js"
import { faceTitle, FavFaces } from "./favfaces.js"
import { fitForModel } from "./image-fit.js"
import { stickerLabel, StickerBook } from "./stickers.js"
import { providerLabel } from "./provider.js"
import { createVoice, recordUrl } from "./voice.js"

const HELP = "在的。只有这个群里被 @、句子里有「爱丽丝」，或者接着刚才跟她的对话说，才会回。别的群不会跟着回，回复别人的消息也不会插话。她看得到最近的群聊，记得和你最近说过的话，也记得记下的事。发送 /reset 会忘掉和你的这段对话，记下的事还在。把表情和「保存表情」一起发过来，或者回复那条表情再说一次，爱丽丝会存下来。人设写在 persona/default.md，保存后你的下一条消息会带上新内容。"
const POKE = "在的，直接说就行。"
const EMPTY_REPLY = "我这次没组织好回复，换种说法再试一次？"
const NUDGES = [
  "被戳到了。",
  "爱丽丝在的。",
  "干嘛戳爱丽丝。",
  "在的。",
]
const FOLLOW_MS = 2 * 60 * 1000
const AFTER_HER_MS = 90 * 1000
const BURST_MS = 1200
const STALE_FOLLOW_MS = 20 * 1000
const LINGER_WAIT_MS = 30 * 1000
const LINGER_GAP_MS = 4 * 60 * 1000

const config = await loadConfig()
const log = (message) => {
  const time = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).replace("T", " ")
  console.log(`[${time}] ${message}`)
}

await mkdir(config.workspace, { recursive: true })
const store = new SessionStore(config.storeFile)
await store.load()
const book = new StickerBook(config.stickerDir)
await book.load()
const fav = new FavFaces(config.favDir)
await fav.load()
const notebook = new Notebook(config.noteFile)
await notebook.load()
const memory = new Memory(path.join(root, "data", "memory.json"))
await memory.load()
const room = new GroupLog()
const nudgeAt = new Map()
const recentImages = new Map()
const recentImageJobs = new Map()
const lastExchange = new Map()
const lastSelfAt = new Map()
const ownMessageIds = new Map()
const groupNames = new Map()
const bursts = new Map()
const depths = new Map()
const tails = new Map()
const lingerTimers = new Map()
const lingerEpoch = new Map()
let silenceEpoch = 0
const quietGroups = new Set()
const botTurns = new Map()
const botListFile = path.join(root, "bot-list.txt")
let botListCache = { ids: new Set(), mtimeMs: -1 }
const lastLingerAt = new Map()
let namingFaces = false
let active = 0
const waiters = []

const model = new ModelClient({
  provider: config.dsh.provider,
  replyTimeoutMs: config.dsh.replyTimeoutMs,
  log,
})
const onebot = new OneBotClient({
  wsUrl: config.napcat.wsUrl,
  accessToken: config.napcat.accessToken,
  log,
})

log(`配置：${config.file}`)
log(`触发方式：${config.bot.trigger === "all" ? "群里每条消息" : "只有 @ 机器人"}`)
log("对话记忆：每个人最近 8 轮、群里最近 20 句，加上记事本")
log(`已保存表情：${book.names().length} 个`)
log(`记事本：${Object.values(notebook.groups).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)} 条`)
const voices = createVoice({ config: config.voice, dir: path.join(root, "data", "voice"), log })
if (voices.enabled) {
  log("语音：短句交给本机 GPT-SoVITS，失败就改回文字")
  void voices.warm()
}
log(`接口：${providerLabel(config.dsh.provider)}，直接请求，不经过 dsh`)
log(`管理员：${ADMIN_ID}`)
await botIds()
if (config.bot.groups.length === 0) log("群白名单为空，所有群的触发消息都会回复")

onebot.onEvent = (event) => {
  const action = decide(event, {
    selfId: onebot.selfId,
    trigger: config.bot.trigger,
    groups: config.bot.groups,
    admins: config.bot.admins,
  })
  if (action.type === "ignore") return
  if (action.type === "stop" || action.type === "restart" || action.type === "api" || action.type === "reset") {
    void runAdmin(action)
    return
  }
  cancelLinger(action.groupId)
  action.arrivedAt = Date.now()
  action.replyingToHer = replyingToHer(action)
  rememberLine(action)
  if (String(action.userId) === ADMIN_ID && action.type === "chat") {
    const order = quietOrder(action.text, {
      toHer: Boolean(action.mentioned || action.replyingToHer || callsHer(action.text)),
    })
    if (order && !namesSomeoneElse(action.text, heardBefore(action).names)) {
      void setQuiet(action, order)
      return
    }
  }
  if (heldBack(action)) return
  if (action.media?.length) {
    void rememberImage(threadKey(action.groupId, action.userId), action.media.at(-1))
  }
  if (action.type !== "chat") {
    startJob(threadKey(action.groupId, action.userId), action)
    return
  }
  const key = threadKey(action.groupId, action.userId)
  const bucket = bursts.get(key) ?? { actions: [] }
  bucket.actions.push(action)
  bursts.set(key, bucket)
  clearTimeout(bucket.timer)
  bucket.timer = setTimeout(() => flushBurst(key), BURST_MS)
}

function stickerCatalog() {
  if (!fav.stale()) return Promise.resolve(fav.promptList(book.names()))
  return fav.refresh(onebot)
    .then((result) => {
      const waiting = result.pending ? `，${result.pending} 张准备看图起名` : ""
      const skipped = result.unnamed ? `，${result.unnamed} 张没能收下` : ""
      log(`QQ 表情收藏：${result.named} 张可用${waiting}${skipped}`)
      void nameNewFaces()
      return fav.promptList(book.names())
    })
    .catch((error) => {
      log(`读取表情收藏失败：${error.message}`)
      return fav.promptList(book.names())
    })
}
onebot.onReady = () => {
  void stickerCatalog()
  void repairStickerNames()
}
onebot.start()

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  log("正在退出")
  onebot.stop()
  model.cancelAll()
  process.exit(0)
}
process.on("SIGINT", () => { void shutdown() })
process.on("SIGTERM", () => { void shutdown() })

function rememberLine(action) {
  room.push(action.groupId, {
    id: action.messageId,
    name: action.senderName,
    userId: action.userId,
    text: action.text || (action.type === "nudge" ? "戳了爱丽丝" : "…"),
    replyTo: action.replyTo,
  })
}

function flushBurst(key) {
  const bucket = bursts.get(key)
  if (!bucket?.actions.length) {
    bursts.delete(key)
    return
  }
  if ((depths.get(key) ?? 0) >= 2) {
    bucket.timer = setTimeout(() => flushBurst(key), BURST_MS)
    return
  }
  const actions = bucket.actions.splice(0)
  bursts.delete(key)
  const merged = mergeBurst(actions)
  const mode = modeOf(merged)
  if (mode === "skip" || mode === "ambient") return
  if (mode === "followup" && active + waiters.length >= config.bot.maxParallel) {
    log(`群 ${merged.groupId} 正在回复别人，先不接 ${merged.userId}`)
    return
  }
  startJob(key, merged)
}

function startJob(key, action) {
  action.silenceEpoch = silenceEpoch
  const depth = depths.get(key) ?? 0
  if (depth >= 3) {
    log(`群 ${action.groupId} 的 ${action.userId} 排队已满，这轮先不接`)
    return
  }
  depths.set(key, depth + 1)
  enqueue(key, () => handle(action))
    .catch((error) => log(`群 ${action.groupId} 的 ${action.userId} 处理失败：${error.message}`))
    .finally(() => depths.set(key, Math.max((depths.get(key) ?? 1) - 1, 0)))
}

function modeOf(action) {
  const key = threadKey(action.groupId, action.userId)
  const toHer = action.replyingToHer ?? replyingToHer(action)
  const heard = heardBefore(action)
  return addressMode({
    mentioned: Boolean(action.mentioned),
    text: action.text,
    replyingToHer: toHer,
    replyingToOther: action.replyingToOther ?? (Boolean(action.replyTo) && !toHer),
    recentWithUser: Date.now() - (lastExchange.get(key) ?? 0) < FOLLOW_MS,
    sheJustRepliedToUser: repliedToUserJustNow(action.groupId, action.userId),
    pointingAtOwnImage: pointingAtOwnImage(action),
    speakerNames: heard.names,
    previous: heard.previous,
  })
}

function heardBefore(action) {
  const skip = new Set((action.messageIds ?? [action.messageId]).map((id) => String(id ?? "")).filter(Boolean))
  const names = []
  let previous = null
  for (const line of [...room.recent(action.groupId)].reverse()) {
    if (skip.has(String(line.id ?? ""))) continue
    if (!previous && (line.self || line.userId !== String(action.userId))) previous = line
    if (line.self || line.userId === String(action.userId)) continue
    const name = String(line.name ?? "").trim()
    if (name && name !== "群友" && !names.includes(name)) names.push(name)
  }
  return { names, previous }
}

function pointingAtOwnImage(action) {
  const id = String(action.replyTo ?? "")
  if (!id) return false
  return room.recent(action.groupId).some((line) =>
    line.id === id && line.userId === String(action.userId) && /图片|表情包/.test(line.text))
}

function repliedToUserJustNow(groupId, userId) {
  if (Date.now() - (lastSelfAt.get(groupId) ?? 0) >= AFTER_HER_MS) return false
  const lines = room.recent(groupId)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].self) continue
    return lines[index].to === String(userId)
  }
  return false
}

async function handle(action) {
  if (quieted(action)) return
  const key = threadKey(action.groupId, action.userId)
  if ((await botIds()).has(String(action.userId))) {
    const next = listedBotTurn(botTurns.get(key), Date.now())
    botTurns.set(key, { rounds: next.rounds, cooldownUntil: next.cooldownUntil })
    if (next.action === "silent") {
      log(`群 ${action.groupId} 的 ${action.userId} 在机器人名单上，先不接`)
      return
    }
    if (next.action === "closing") {
      log(`群 ${action.groupId} 的 ${action.userId} 已经聊了两轮，收个尾`)
      await reply(action, BOT_CLOSING)
      return
    }
  }
  if (action.type === "help") {
    const extra = String(action.userId) === ADMIN_ID
      ? "\n管理员可以说「暂时安静一会儿」，这个群就先不回别人；说「可以说话了」再开口。也可以发 /stop 停下正在跟别人的对话，/restart 重启，/api 看现在的接口，/api 书生、/api deepseek 或 /api qwen 切换。"
      : ""
    await reply(action, HELP + extra)
    return
  }
  if (action.type === "poke") {
    await reply(action, POKE)
    return
  }
  if (action.type === "nudge") {
    await reactToNudge(action)
    return
  }
  if (action.type === "save") {
    await saveIncomingSticker(action)
    return
  }
  const mode = modeOf(action)
  if (mode === "skip" || mode === "ambient") return
  action.addressed = mode === "direct"
  action.followup = mode === "followup"
  action.aside = mode === "aside"
  if (action.followup && Date.now() - (action.arrivedAt ?? Date.now()) > STALE_FOLLOW_MS) {
    log(`群 ${action.groupId} 的 ${action.userId} 这句已经过去了`)
    return
  }
  if (action.addressed) lastExchange.set(key, Date.now())

  const persona = await readFile(config.bot.personaFile, "utf8")
  const groupName = await groupNameOf(action.groupId)
  const image = await imageForTurn(key, action)
  if (image) log(`这轮带上图片`)
  const catalog = await stickerCatalog()
  const transcript = formatTranscript(room.recent(action.groupId), action.messageIds ?? action.messageId)
  let material = ""
  if (config.search.enabled && needsSearch(action.text)) {
    material = await gatherSearch(action.text, config.search)
    log(material.startsWith("搜索没连上") ? `搜索没连上：群 ${action.groupId}` : `查了资料：群 ${action.groupId}`)
  }
  if (quieted(action)) return
  const promptFor = (hasImage) => buildPrompt({
    persona,
    senderName: action.senderName,
    userId: action.userId,
    groupName,
    groupId: action.groupId,
    text: action.text,
    includePersona: true,
    stickerCatalog: catalog,
    hasImage,
    carriedImage: Boolean(action.carriedImage),
    transcript,
    notes: notebook.notes(action.groupId),
    dialogue: formatDialogue(memory.recall(key), action.senderName),
    addressed: action.addressed,
    aside: action.aside,
    followup: action.followup,
    material,
  })
  const prompt = promptFor(Boolean(image))
  if (quieted(action)) return
  let result
  try {
    result = await model.complete(key, image ? [imageBlock(image), { type: "text", text: prompt }] : prompt)
  } catch (error) {
    if (quieted(action) || cancelled(error)) return
    if (image && /image|vision|multimodal/i.test(String(error.message))) {
      log(`看图失败，改为只看文字：${error.message}`)
      try {
        result = await model.complete(key, promptFor(false))
      } catch (again) {
        if (quieted(action) || cancelled(again)) return
        if (String(again.message).includes("超时")) {
          await reply(action, "想得有点久，这次先不回了。")
          return
        }
        throw again
      }
    } else if (String(error.message).includes("超时")) {
      await reply(action, "想得有点久，这次先不回了。")
      return
    } else {
      throw error
    }
  }
  logModel(result)
  const aside = takeAsides(result.text)
  const added = await notebook.add(action.groupId, aside.notes)
  if (added.length > 0) log(`记下：${added.join("；")}`)
  if (aside.keeps[0]) {
    const kept = await keepSticker(action, aside.keeps[0])
    if (kept && !aside.text.trim()) {
      const line = `收下了。之后可以用「${kept.name}」发出来。`
      await memory.add(key, action.text, line)
      await reply(action, line)
      return
    }
  }
  if (aside.silent && !action.addressed) {
    log(`没有接话：群 ${action.groupId} 的 ${action.userId}`)
    return
  }
  if (quieted(action) || heldBack(action)) return
  const spoken = aside.silent ? "在的。" : replyHeard(aside)
  await memory.add(key, action.text, spoken)
  await deliver(action, aside.silent ? "在的。" : aside.text, true, aside.silent ? "" : aside.voice)
}

function replyHeard(aside) {
  const text = String(aside.text ?? "").trim()
  const voice = String(aside.voice ?? "").trim()
  if (text && voice) return `${text}（并念了：${voice}）`
  return text || voice
}

function logModel(result) {
  const first = (result.ttftMs / 1000).toFixed(1)
  const total = (result.elapsedMs / 1000).toFixed(1)
  log(`模型首字 ${first} 秒，整段 ${total} 秒`)
}

function cancelled(error) {
  return String(error?.message ?? "").includes("已取消")
}

async function groupNameOf(groupId) {
  if (groupNames.has(groupId)) return groupNames.get(groupId)
  try {
    const result = await onebot.call("get_group_info", { group_id: /^\d+$/.test(groupId) ? Number(groupId) : groupId }, 5000)
    const name = String(result?.data?.group_name || groupId)
    groupNames.set(groupId, name)
    return name
  } catch {
    return groupId
  }
}

async function reply(action, text) {
  await deliver(action, text, false)
}

function heldBack(action) {
  return quietGroups.has(String(action.groupId ?? "")) && String(action.userId ?? "") !== ADMIN_ID
}

async function setQuiet(action, order) {
  const groupId = String(action.groupId)
  if (order === "quiet") {
    const already = quietGroups.has(groupId)
    quietGroups.add(groupId)
    cancelLinger(groupId)
    for (const [key, bucket] of bursts) {
      if (!key.startsWith(`${groupId}:`) || key.endsWith(`:${ADMIN_ID}`)) continue
      clearTimeout(bucket.timer)
      bursts.delete(key)
    }
    for (const key of model.activeKeys()) {
      if (key === `linger:${groupId}`) model.cancel(key)
      if (key.startsWith(`${groupId}:`) && !key.endsWith(`:${ADMIN_ID}`)) model.cancel(key)
    }
    log(already ? `群 ${groupId} 还在安静` : `群 ${groupId} 先安静`)
    await reply(action, already ? "已经安静着。" : "好，先安静一会儿。")
    return
  }
  if (!quietGroups.has(groupId)) {
    await reply(action, "现在没有在安静。")
    return
  }
  quietGroups.delete(groupId)
  log(`群 ${groupId} 可以说话了`)
  await reply(action, "好，爱丽丝可以说话了。")
}

async function deliver(action, text, pauseFirst, voice) {
  if (heldBack(action)) return
  const planned = planVoice(text, voice, pauseFirst && !action.linger && action.type === "chat")
  const bubbles = planned.body ? (pauseFirst ? splitBubbles(planned.body) : [planned.body]) : []
  const pieces = bubbles.length > 0 ? bubbles : (planned.speak ? [] : [String(text ?? "").trim()])
  for (let index = 0; index < pieces.length; index += 1) {
    if (index === 0 && pauseFirst) await pause(700 + Math.floor(Math.random() * 900))
    if (index > 0) await pause(1000 + Math.floor(Math.random() * 1000))
    await sendBubble(action, pieces[index], index === 0 && !planned.speak)
  }
  if (planned.speak) await sendVoice(action, planned.speak, pieces.length === 0, pauseFirst && pieces.length === 0)
  if (pauseFirst && !action.linger) scheduleLinger(action.groupId)
}

async function sendVoice(action, line, quoteThis, pauseFirst) {
  if (pauseFirst) await pause(700 + Math.floor(Math.random() * 900))
  try {
    const file = await voices.synthesize(line)
    const segments = [{ type: "record", data: { file: recordUrl(file) } }]
    const sent = await onebot.sendGroupSegments(action.groupId, segments)
    const sentId = sentMessageId(sent)
    room.push(action.groupId, {
      id: sentId,
      name: "爱丽丝",
      userId: onebot.selfId,
      text: `[语音]${line}`,
      self: true,
      to: "",
    })
    if (sentId) rememberOwnMessage(action.groupId, sentId)
    lastSelfAt.set(action.groupId, Date.now())
    log(`已发语音给群 ${action.groupId} 的 ${action.userId}`)
  } catch (error) {
    log(`语音没合成出来，改为文字：${error.message}`)
    await sendBubble(action, line, quoteThis)
  }
}

async function sendBubble(action, text, quoteThis) {
  const built = composeReply(text)
  let segments = built.segments
  if (segments.length === 0) {
    const fallback = built.missingSticker ? "爱丽丝的表情袋里没有这个。" : EMPTY_REPLY
    segments = [{ type: "text", data: { text: fallback } }]
  }
  const quote = quoteThis && shouldQuote(action)
  if (quote) {
    segments.unshift({ type: "reply", data: { id: String(action.messageId) } })
  }
  const sent = await onebot.sendGroupSegments(action.groupId, segments)
  const sentId = sentMessageId(sent)
  room.push(action.groupId, {
    id: sentId,
    name: "爱丽丝",
    userId: onebot.selfId,
    text: segments.filter((segment) => segment.type === "text").map((segment) => segment.data.text).join("") || "[表情]",
    self: true,
    to: quote ? action.userId : "",
  })
  if (sentId) rememberOwnMessage(action.groupId, sentId)
  lastSelfAt.set(action.groupId, Date.now())
  if (quote) lastExchange.set(threadKey(action.groupId, action.userId), Date.now())
  log(`已回复群 ${action.groupId} 的 ${action.userId}${quote ? "" : "（直接发到群里）"}`)
}

function scheduleLinger(groupId) {
  const key = String(groupId ?? "")
  if (!key) return
  if (Date.now() - (lastLingerAt.get(key) ?? 0) < LINGER_GAP_MS) return
  clearTimeout(lingerTimers.get(key))
  const timer = setTimeout(() => { void maybeLinger(key) }, LINGER_WAIT_MS)
  lingerTimers.set(key, timer)
}

function cancelLinger(groupId) {
  const key = String(groupId ?? "")
  if (!key) return
  clearTimeout(lingerTimers.get(key))
  lingerTimers.delete(key)
  lingerEpoch.set(key, (lingerEpoch.get(key) ?? 0) + 1)
  model.cancel(`linger:${key}`)
}

async function maybeLinger(groupId) {
  lingerTimers.delete(groupId)
  const epoch = lingerEpoch.get(groupId) ?? 0
  if (active + waiters.length >= config.bot.maxParallel) return
  if (quietGroups.has(String(groupId))) return
  const lines = room.recent(groupId)
  const lastIndex = lines.findLastIndex((line) => line.self)
  if (lastIndex < 0) return
  if (lines.slice(lastIndex + 1).some((line) => !line.self)) return
  lastLingerAt.set(groupId, Date.now())
  try {
    const persona = await readFile(config.bot.personaFile, "utf8")
    const result = await model.complete(`linger:${groupId}`, buildLingerPrompt({
      persona,
      transcript: formatTranscript(lines),
      lastLine: lines[lastIndex].text,
    }))
    logModel(result)
    if ((lingerEpoch.get(groupId) ?? 0) !== epoch) return
    const aside = takeAsides(result.text)
    const line = aside.text.split(/\n/).map((part) => part.trim()).filter(Boolean)[0] ?? ""
    if (aside.silent || !line) {
      log(`群 ${groupId} 安静着，没有补话`)
      return
    }
    await deliver({
      type: "chat",
      groupId,
      userId: "",
      messageId: "",
      senderName: "",
      text: line,
      linger: true,
    }, line, false)
    log(`群 ${groupId} 补了一句`)
  } catch (error) {
    if (cancelled(error)) return
    log(`补话失败：${error.message}`)
  }
}

function replyingToHer(action) {
  const id = String(action.replyTo ?? "")
  if (!id) return false
  if (ownMessageIds.get(action.groupId)?.has(id)) return true
  return room.recent(action.groupId).some((line) => line.self && line.id === id)
}

function shouldQuote(action) {
  if (!config.bot.replyWithQuote || !action.messageId) return false
  if (action.type === "chat") return Boolean(action.addressed)
  return true
}

function sentMessageId(sent) {
  const id = sent?.message_id ?? sent?.messageId
  return id === undefined || id === null ? "" : String(id)
}

function rememberOwnMessage(groupId, id) {
  const key = String(groupId)
  const ids = ownMessageIds.get(key) ?? new Set()
  ids.add(String(id))
  while (ids.size > 40) ids.delete(ids.values().next().value)
  ownMessageIds.set(key, ids)
}

function composeReply(text) {
  const parsed = parseOutgoing(text)
  const segments = []
  let used = 0
  let missingSticker = false
  const limit = config.bot.maxReplyLength
  for (const part of parsed.parts) {
    if (part.type === "text") {
      let piece = part.text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n")
      if (!piece.trim() || used >= limit) continue
      if (segments.length === 0) piece = piece.trimStart()
      const room = limit - used
      const clipped = piece.length <= room ? piece : `${piece.slice(0, Math.max(room - 1, 0))}…`
      used += clipped.trim().length
      const last = segments.at(-1)
      if (last?.type === "text") last.data.text += clipped
      else segments.push({ type: "text", data: { text: clipped } })
    } else if (part.type === "face") {
      continue
    } else if (part.type === "sticker") {
      const sticker = fav.find(part.name) || book.find(part.name)
      if (!sticker) missingSticker = true
      else segments.push({ type: "image", data: { file: sticker.file, sub_type: 1, summary: stickerLabel(sticker.name) || stickerLabel(sticker.summary) || "表情" } })
    } else if (part.type === "dice") {
      segments.push({ type: "dice", data: {} })
    } else if (part.type === "rps") {
      segments.push({ type: "rps", data: {} })
    }
  }
  const ending = segments.at(-1)
  if (ending?.type === "text") ending.data.text = ending.data.text.trimEnd()
  const sentStickers = segments.filter((segment) => segment.type === "image").length
  if (sentStickers > 0) log(`这条带了 ${sentStickers} 张表情`)
  else if (missingSticker) log("模型点了表情，收藏里没有同名的")
  return { segments, reacts: parsed.reacts, missingSticker }
}

async function reactToNudge(action) {
  const key = threadKey(action.groupId, action.userId)
  const now = Date.now()
  const last = nudgeAt.get(key) ?? 0
  if (now - last < 8000) return
  const quiet = now - last < 25000
  nudgeAt.set(key, now)
  lastExchange.set(key, now)
  await pause(400 + Math.floor(Math.random() * 500))
  await onebot.pokeGroup(action.groupId, action.userId).catch((error) => log(`回戳失败：${error.message}`))
  if (quiet) return
  await pause(500 + Math.floor(Math.random() * 700))
  const line = NUDGES[Math.floor(Math.random() * NUDGES.length)]
  const sent = await onebot.sendGroupText(action.groupId, line)
  const sentId = sentMessageId(sent)
  room.push(action.groupId, { id: sentId, name: "爱丽丝", userId: onebot.selfId, text: line, self: true, to: action.userId })
  if (sentId) rememberOwnMessage(action.groupId, sentId)
  lastSelfAt.set(action.groupId, Date.now())
  log(`已回戳群 ${action.groupId} 的 ${action.userId}`)
}

async function imageForTurn(key, action) {
  if (action.media?.[0]) return rememberImage(key, action.media[0])
  const quoted = await quotedImage(action)
  if (quoted) {
    action.carriedImage = true
    return rememberImage(key, quoted)
  }
  const pending = recentImageJobs.get(key)
  const recent = pending ? await pending : recentImages.get(key)
  if (!recent) return null
  if (!shouldCarryImage({
    addressed: action.addressed,
    text: action.text,
    ageMs: Date.now() - (recent.savedAt ?? 0),
  })) return null
  action.carriedImage = true
  log(`沿用 ${key} 刚发过的图片`)
  return recent
}

async function quotedImage(action) {
  if (!action.replyTo) return null
  try {
    const message = await onebot.getMessage(action.replyTo)
    return messageMedia(message?.message)[0] ?? null
  } catch (error) {
    log(`读取被回复的图片失败：${error.message}`)
    return null
  }
}

function imageBlock(image) {
  return { type: "image", mimeType: image.mimeType, data: image.data }
}

function rememberImage(key, media) {
  const job = downloadImage(media).then((image) => {
    image.savedAt = Date.now()
    recentImages.set(key, image)
    log(`已收到图片 ${mediaBrief(media)}`)
    return image
  }).catch((error) => {
    log(`读取图片失败：${error.message}`)
    return null
  })
  recentImageJobs.set(key, job)
  return job
}

async function saveIncomingSticker(action) {
  const media = await mediaForSave(action, false)
  if (!media) {
    await reply(action, "把表情和「保存表情」一起发过来，或者回复那条表情再说一次。")
    return
  }
  try {
    const saved = await storeSticker(action, media, action.saveName)
    await reply(action, saved.collected
      ? `收下了。之后爱丽丝可以用「${saved.name}」发出来，也放进表情收藏了。`
      : `收下了，名字是「${saved.name}」。QQ 的表情收藏这次没放进去，不过爱丽丝这边还能发。`)
  } catch (error) {
    log(`保存表情失败：${error.message}`)
    await reply(action, "这张表情没存住，再发一次试试。")
  }
}

async function keepSticker(action, name) {
  const media = await mediaForSave(action, true)
  if (!media) return null
  try {
    const saved = await storeSticker(action, media, name)
    log(`自己收下表情：${saved.name}`)
    return saved
  } catch (error) {
    log(`自己收下表情失败：${error.message}`)
    return null
  }
}

async function mediaForSave(action, stickersOnly) {
  const key = threadKey(action.groupId, action.userId)
  let media = stickersOnly
    ? (action.media ?? []).find((item) => isReusableSticker(item))
    : action.media?.[0]
  if (!media && action.replyTo) {
    try {
      const message = await onebot.getMessage(action.replyTo)
      media = messageMedia(message?.message)[0]
    } catch (error) {
      log(`读取被回复的消息失败：${error.message}`)
    }
  }
  if (!media) media = recentImages.get(key)?.media
  if (!media) return null
  if (stickersOnly && !isReusableSticker(media)) return null
  return media
}

async function storeSticker(action, media, name) {
  const key = threadKey(action.groupId, action.userId)
  const image = await rememberImage(key, media)
  if (!image?.source) throw new Error("没有下载到文件")
  let label = stickerLabel(name) || stickerLabel(media.summary)
  if (!label) label = await captionSticker(image.source)
  const saved = await book.add({
    name: label || "",
    source: image.source,
    summary: label || "",
    emojiId: media.emojiId,
    packageId: media.packageId,
    key: media.key,
  })
  let collected = true
  try {
    await onebot.addCustomFace(saved)
  } catch (error) {
    collected = false
    log(`放进 QQ 表情收藏失败：${error.message}`)
  }
  return { ...saved, collected }
}

async function downloadImage(media) {
  const source = await locateMedia(media)
  const bytes = await readFile(source)
  if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw new Error("图片大小不合适")
  const fitted = await fitForModel(bytes)
  if (fitted) return { media, source, mimeType: fitted.mimeType, data: fitted.data }
  if (bytes.length > 2 * 1024 * 1024) throw new Error("图片大小不合适")
  const mimeType = sniffMime(bytes)
  if (!mimeType) throw new Error("不是支持的图片格式")
  return { media, source, mimeType, data: bytes.toString("base64") }
}

async function nameNewFaces() {
  if (namingFaces || fav.pending.length === 0) return
  namingFaces = true
  try {
    const count = await fav.namePending((file) => captionSticker(file))
    if (count > 0) log(`给 ${count} 张收藏表情起了名字`)
  } catch (error) {
    log(`给收藏表情起名失败：${error.message}`)
  } finally {
    namingFaces = false
  }
}

async function captionSticker(file) {
  const bytes = await readFile(file)
  const fitted = await fitForModel(bytes)
  if (!fitted) return ""
  const result = await model.complete("caption", [
    { type: "image", mimeType: fitted.mimeType, data: fitted.data },
    { type: "text", text: "这是一张 QQ 表情。只输出一个 2 到 8 个字的中文名字，描述画面或情绪。不要解释，不要调用工具，不要加标点。不要输出「动画表情」。" },
  ])
  return faceTitle(result.text)
}

async function repairStickerNames() {
  const broken = book.items.filter((item) => !stickerLabel(item.name))
  for (const item of broken) {
    try {
      const name = await captionSticker(item.file)
      if (!name) continue
      const renamed = await book.rename(item.id, name)
      if (renamed) log(`表情改名：${renamed.name}`)
    } catch (error) {
      log(`表情改名失败：${error.message}`)
    }
  }
}

async function locateMedia(media) {
  await mkdir(config.stickerDir, { recursive: true })
  const url = stickerUrl(media)
  if (!url && media?.file) {
    try {
      await access(media.file)
      return media.file
    } catch {
      // 继续按网络地址下载。
    }
  }
  if (!url) throw new Error("没有图片地址")
  try {
    const downloaded = await onebot.downloadFile(url, `face-${Date.now()}.gif`)
    if (downloaded) return downloaded
  } catch (error) {
    log(`NapCat 下载表情失败，改用直接下载：${error.message}`)
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const dest = path.join(config.stickerDir, `fetch-${Date.now()}.gif`)
  await writeFile(dest, bytes)
  return dest
}

function sniffMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp"
  return ""
}

function mediaBrief(media) {
  let host = ""
  try {
    host = new URL(media?.url ?? "").host
  } catch {
    host = media?.url ? "非链接" : ""
  }
  return `url=${host || "无"} emoji=${media?.emojiId || "无"} summary=${media?.summary || "无"}`
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function botIds() {
  try {
    const info = await stat(botListFile)
    if (info.mtimeMs === botListCache.mtimeMs) return botListCache.ids
    const ids = new Set(parseBotList(await readFile(botListFile, "utf8")))
    botListCache = { ids, mtimeMs: info.mtimeMs }
    log(`机器人名单 ${ids.size} 个：${botListFile}`)
    return ids
  } catch {
    if (botListCache.mtimeMs !== 0) {
      botListCache = { ids: new Set(), mtimeMs: 0 }
      log(`没有读到机器人名单：${botListFile}`)
    }
    return botListCache.ids
  }
}

function quieted(action) {
  return action.silenceEpoch !== silenceEpoch
}

async function runAdmin(action) {
  const key = threadKey(action.groupId, action.userId)
  try {
    if (action.type === "reset") {
      model.cancel(key)
      if (store.get(key)) await store.delete(key)
      await memory.delete(key)
      lastExchange.delete(key)
      await reply(action, "你和爱丽丝的这段对话已经重置。")
      return
    }
    if (action.type === "stop") {
      const targets = stopTargets(action.commandTarget)
      stopConversations(targets)
      log(targets.length ? `停下和 ${targets.join("、")} 的对话` : "停下正在进行的对话")
      await reply(action, targets.length ? "好，先不跟这个人聊了。" : "好，先不跟他们聊了。")
      return
    }
    if (action.type === "restart") {
      await reply(action, "爱丽丝重启一下。")
      scheduleRelaunch()
      await shutdown()
      return
    }
    const choice = parseApiChoice(action.commandTarget)
    if (!choice) {
      await reply(action, "可以说 /api 书生、/api deepseek，或者 /api qwen。")
      return
    }
    if (choice === "status") {
      await reply(action, `现在用的是${providerLabel(config.dsh.provider)}。要换的话，发 /api 书生、/api deepseek 或 /api qwen。`)
      return
    }
    if (choice === config.dsh.provider) {
      await reply(action, `现在用的就是${providerLabel(choice)}。`)
      return
    }
    await writeProvider(choice)
    await reply(action, `换成${providerLabel(choice)}了，爱丽丝重启一下。`)
    scheduleRelaunch()
    await shutdown()
  } catch (error) {
    log(`管理指令失败：${error.message}`)
    await reply(action, "这次没做成。").catch(() => {})
  }
}

function stopConversations(userIds) {
  silenceEpoch += 1
  for (const [key, timer] of lingerTimers) {
    clearTimeout(timer)
    lingerEpoch.set(key, (lingerEpoch.get(key) ?? 0) + 1)
  }
  lingerTimers.clear()
  const chosen = (key) => userIds.some((id) => key.endsWith(`:${id}`))
  if (userIds.length === 0) {
    lastExchange.clear()
    lastSelfAt.clear()
    for (const [, bucket] of bursts) clearTimeout(bucket.timer)
    bursts.clear()
    model.cancelAll()
    return
  }
  for (const [key, bucket] of bursts) {
    if (!chosen(key)) continue
    clearTimeout(bucket.timer)
    bursts.delete(key)
  }
  for (const key of lastExchange.keys()) {
    if (chosen(key)) lastExchange.delete(key)
  }
  for (const groupId of [...lastSelfAt.keys()]) {
    if (userIds.some((id) => repliedToUserJustNow(groupId, id))) lastSelfAt.delete(groupId)
  }
  for (const key of model.activeKeys()) {
    if (chosen(key)) model.cancel(key)
  }
}

async function writeProvider(provider) {
  const raw = JSON.parse(await readFile(config.file, "utf8"))
  raw.dsh = { ...(raw.dsh ?? {}), provider }
  await writeFile(config.file, `${JSON.stringify(raw, null, 2)}\n`, "utf8")
}

function scheduleRelaunch() {
  const script = [
    "Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue",
    "Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue",
    "$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')",
    "Start-Sleep -Seconds 2",
    "Set-Location D:\\aicoding\\aris",
    "npm start",
  ].join("\r\n")
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  const child = spawn("powershell.exe", ["-NoExit", "-EncodedCommand", encoded], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  })
  child.unref()
}

function enqueue(key, job) {
  const previous = tails.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => limit(job))
  tails.set(key, next)
  return next
}

function limit(job) {
  if (active < config.bot.maxParallel) {
    active += 1
    return job().finally(release)
  }
  return new Promise((resolve, reject) => {
    waiters.push(() => {
      active += 1
      job().then(resolve, reject).finally(release)
    })
  })
}

function release() {
  active -= 1
  const next = waiters.shift()
  if (next) next()
}
