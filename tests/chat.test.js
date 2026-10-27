import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { PassThrough } from "node:stream"
import { AcpClient } from "../src/acp-client.js"
import { addressMode, ADMIN_ID, BOT_CLOSING, BOT_COOLDOWN_MS, buildLingerPrompt, buildPrompt, choosePermission, cleanReply, decide, IMAGE_CARRY_MS, isAddressed, isMentioned, isReusableSticker, listedBotTurn, mergeBurst, messageText, namesSomeoneElse, needsFresh, parseApiChoice, parseBotList, parseOutgoing, planVoice, quietOrder, refersToImage, shouldCarryImage, splitBubbles, stickerSaveRequest, stopTargets, takeAsides, threadKey, withAccessToken, youForOther } from "../src/chat.js"
import { faceTitle } from "../src/favfaces.js"
import { formatTranscript } from "../src/room.js"
import { SessionStore } from "../src/store.js"
import { stickerLabel, StickerBook } from "../src/stickers.js"

const selfId = "10000"

test("只在被 @ 时回复群消息", () => {
  const mentioned = decide(groupEvent([
    { type: "at", data: { qq: selfId } },
    { type: "text", data: { text: " 今天吃什么" } },
  ]), { selfId, trigger: "mention" })
  assert.equal(mentioned.type, "chat")
  assert.equal(mentioned.text, "今天吃什么")

  const ignored = decide(groupEvent([{ type: "text", data: { text: "随便聊聊" } }]), { selfId, trigger: "mention" })
  assert.equal(ignored.type, "ignore")

  const everyone = decide(groupEvent([{ type: "text", data: { text: "今天上海天气" } }], { user_id: 9 }), { selfId, trigger: "all" })
  assert.equal(everyone.type, "chat")
  assert.equal(everyone.userId, "9")
  assert.equal(everyone.text, "今天上海天气")
})

test("字符串 CQ 码同样识别 @", () => {
  assert.equal(isMentioned(`[CQ:at,qq=${selfId}] 你好`, selfId), true)
  assert.equal(messageText(`[CQ:at,qq=${selfId}] 看图[CQ:image,file=a.jpg]`, selfId).trim(), "看图[图片]")
})

test("白名单、自己的消息和 /reset", () => {
  const outside = decide(groupEvent([{ type: "at", data: { qq: selfId } }, { type: "text", data: { text: " hi" } }], { group_id: 9 }), {
    selfId,
    trigger: "mention",
    groups: ["8"],
  })
  assert.equal(outside.type, "ignore")

  const self = decide(groupEvent([{ type: "text", data: { text: "回声" } }], { user_id: selfId }), { selfId, trigger: "all" })
  assert.equal(self.type, "ignore")

  const reset = decide(groupEvent([
    { type: "at", data: { qq: selfId } },
    { type: "text", data: { text: " /reset" } },
  ], { user_id: 7 }), { selfId, trigger: "mention", admins: ["7"] })
  assert.equal(reset.type, "reset")

  const blocked = decide(groupEvent([
    { type: "at", data: { qq: selfId } },
    { type: "text", data: { text: " /reset" } },
  ], { user_id: 8 }), { selfId, trigger: "mention", admins: ["7"] })
  assert.equal(blocked.type, "ignore")

  const nobody = decide(groupEvent([{ type: "text", data: { text: "/reset" } }], { user_id: 7 }), { selfId, trigger: "all", admins: [] })
  assert.equal(nobody.type, "ignore")
})

test("只有指定管理员能停下对话、重启和切换接口", () => {
  const outsider = decide(groupEvent([{ type: "text", data: { text: "/stop" } }], { user_id: 8 }), {
    selfId,
    trigger: "all",
    admins: [ADMIN_ID],
  })
  assert.equal(outsider.type, "ignore")

  const stop = decide(groupEvent([
    { type: "text", data: { text: "/stop " } },
    { type: "at", data: { qq: "2659278812" } },
  ], { user_id: ADMIN_ID }), { selfId, trigger: "all", admins: [ADMIN_ID] })
  assert.equal(stop.type, "stop")
  assert.deepEqual(stopTargets(stop.commandTarget), ["2659278812"])

  const restart = decide(groupEvent([{ type: "text", data: { text: "/restart" } }], { user_id: ADMIN_ID }), {
    selfId,
    trigger: "all",
    admins: [ADMIN_ID],
  })
  assert.equal(restart.type, "restart")
  assert.equal(parseApiChoice(""), "status")
  assert.equal(parseApiChoice("书生"), "tokenplan")
  assert.equal(parseApiChoice("官方"), "deepseek")
  assert.equal(parseApiChoice("qwen"), "qwen")
  assert.equal(parseApiChoice("别的"), "")
  assert.equal(quietOrder("暂时安静一会儿"), "quiet")
  assert.equal(quietOrder("爱丽丝，先安静一会儿", { toHer: true }), "quiet")
  assert.equal(quietOrder("你暂时安静一会儿"), "")
  assert.equal(quietOrder("可以说话了"), "resume")
  assert.equal(quietOrder("今天好热"), "")
})

test("人设只在需要时放进提示词", () => {
  const full = buildPrompt({
    persona: "人设标记-甲",
    senderName: "小王",
    userId: "7",
    groupName: "测试群",
    groupId: "8",
    text: "在吗",
    includePersona: true,
  })
  assert.match(full, /人设标记-甲/)
  assert.match(full, /不要调用工具/)
  assert.match(full, /本机查到的材料/)
  assert.match(full, /这轮还没有查资料/)
  assert.doesNotMatch(full, /web_search/)
  assert.match(full, /不要超过两句/)
  assert.match(full, /最近的群聊/)
  assert.match(full, /表情收藏/)
  assert.doesNotMatch(full, /\[\[face:/)
  assert.equal(threadKey("8", "7"), "8:7")
  assert.notEqual(threadKey("8", "7"), threadKey("8", "9"))
  const later = buildPrompt({
    persona: "人设标记-甲",
    senderName: "小王",
    userId: "7",
    groupName: "测试群",
    groupId: "8",
    text: "在吗",
    includePersona: false,
  })
  assert.doesNotMatch(later, /人设标记-甲/)
  assert.match(buildPrompt({ text: "金价", material: "950.5 元/克" }), /950\.5 元\/克/)
})

test("搜索由模型写出标记，程序只抽出查询", () => {
  assert.equal(needsFresh("明天上海天气"), true)
  assert.equal(needsFresh("今天有什么新闻"), true)
  assert.equal(needsFresh("在吗"), false)
  const aside = takeAsides("[[search:明天上海天气]]")
  assert.equal(aside.search, "明天上海天气")
  assert.equal(aside.text, "")
  const mixed = takeAsides("先记一下[[search:上海金价]][[voice:九百五]]")
  assert.equal(mixed.search, "上海金价")
  assert.equal(mixed.voice, "九百五")
  assert.equal(mixed.text.includes("[["), false)
  assert.match(buildPrompt({ text: "明天上海天气怎么样" }), /\[\[search:查询词\]\]/)
  assert.match(buildPrompt({ text: "金价", material: "950.5 元/克" }), /不要再写 \[\[search:\]\]/)
})

test("工具权限默认拒绝，联网模式只放行搜索", () => {
  const options = {
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  }
  assert.equal(choosePermission(options, "deny", "web_search").outcome.optionId, "reject-once")
  assert.equal(choosePermission(options, "web", "web_search").outcome.optionId, "allow-once")
  assert.equal(choosePermission(options, "web", "web_fetch").outcome.optionId, "allow-once")
  assert.equal(choosePermission(options, "web", "pwsh").outcome.optionId, "reject-once")
  assert.equal(choosePermission(options, "web").outcome.optionId, "reject-once")
  assert.equal(cleanReply("你好呀", 2), "你…")
})

test("戳一戳、保存表情和发出表情", () => {
  const nudge = decide({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    group_id: 8,
    user_id: 7,
    target_id: Number(selfId),
  }, { selfId, groups: ["8"] })
  assert.equal(nudge.type, "nudge")
  assert.equal(nudge.userId, "7")

  const someoneElse = decide({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    group_id: 8,
    user_id: 7,
    target_id: 9,
  }, { selfId, groups: ["8"] })
  assert.equal(someoneElse.type, "ignore")

  const described = messageText([
    { type: "image", data: { summary: "猫猫", emoji_id: "1", url: "https://example.test/a.gif" } },
    { type: "text", data: { text: " 保存表情叫猫猫" } },
  ], selfId)
  const save = decide(groupEvent([
    { type: "image", data: { summary: "猫猫", emoji_id: "1", url: "https://example.test/a.gif" } },
    { type: "text", data: { text: " 保存表情叫猫猫" } },
  ]), { selfId, trigger: "all" })
  assert.match(described, /表情包:猫猫/)
  const placeholder = messageText([
    { type: "image", data: { summary: "[动画表情]", sub_type: "1", url: "https://example.test/a.gif" } },
  ], selfId)
  assert.equal(placeholder, "[表情包]")
  assert.equal(stickerLabel("[动画表情]"), "")
  assert.equal(stickerLabel("[动画表情]3"), "")
  assert.equal(stickerLabel("打气"), "打气")
  assert.equal(save.type, "save")
  assert.equal(save.saveName, "猫猫")
  assert.equal(stickerSaveRequest("把这个表情包存下来")?.name, "")
  assert.equal(stickerSaveRequest("存下来聊聊"), null)
  assert.equal(refersToImage("这个表情你认识是谁吗"), true)
  assert.equal(refersToImage("今天上海天气"), false)
  assert.equal(shouldCarryImage({ addressed: true, text: "看看", ageMs: 20_000 }), true)
  assert.equal(shouldCarryImage({ addressed: false, text: "这张图是什么", ageMs: 20_000 }), true)
  assert.equal(shouldCarryImage({ addressed: false, text: "今天吃什么", ageMs: 20_000 }), false)
  assert.equal(shouldCarryImage({ addressed: true, text: "在吗", ageMs: IMAGE_CARRY_MS + 1 }), false)
  const quoted = decide(groupEvent([
    { type: "reply", data: { id: "9" } },
    { type: "text", data: { text: "把这个表情包存下来" } },
  ]), { selfId, trigger: "all" })
  assert.equal(quoted.type, "save")

  const outgoing = parseOutgoing("收到[[face:微笑]][[sticker:猫猫]][[react:赞]][[dice]]")
  assert.equal(outgoing.parts.some((part) => part.type === "face" && part.id === "14"), true)
  assert.equal(outgoing.parts.some((part) => part.type === "sticker" && part.name === "猫猫"), true)
  assert.deepEqual(outgoing.reacts, ["76"])
  assert.equal(outgoing.parts.some((part) => part.type === "dice"), true)
  assert.equal(outgoing.parts.some((part) => part.type === "text" && part.text.includes("[[")), false)
  const bare = parseOutgoing("在的 [[探头]]")
  assert.equal(bare.parts.some((part) => part.type === "sticker" && part.name === "探头"), true)
  assert.equal(bare.parts.some((part) => part.type === "text" && part.text.includes("[[")), false)
  assert.equal(isAddressed({ mentioned: true, text: "今天吃什么" }), true)
  assert.equal(isAddressed({ mentioned: false, text: "爱丽丝在吗" }), true)
  assert.equal(isAddressed({ mentioned: false, text: "今天吃什么" }), false)
  assert.equal(addressMode({ text: "在干嘛", replyingToHer: true }), "direct")
  assert.equal(addressMode({ text: "在干嘛", recentWithUser: true }), "followup")
  assert.equal(addressMode({ text: "你刚说的是哪句", sheJustRepliedToUser: true }), "followup")
  assert.equal(addressMode({ text: "给你两拳", sheJustSpoke: true }), "ambient")
  assert.equal(addressMode({ text: "今天好热" }), "ambient")
  const burst = mergeBurst([
    { text: "称号是什么", messageId: "1", userId: "8" },
    { text: "头衔是什么", messageId: "2", userId: "8", replyTo: "9" },
  ])
  assert.equal(burst.burst, 2)
  assert.equal(burst.text, "称号是什么\n头衔是什么")
  assert.deepEqual(burst.messageIds, ["1", "2"])
  assert.equal(addressMode({ text: "@12345 你看这个", recentWithUser: true }), "skip")
  assert.equal(addressMode({ text: "@1900984336", pointingAtOwnImage: true, recentWithUser: true }), "skip")
  assert.equal(addressMode({ text: "这是谁", pointingAtOwnImage: true }), "direct")
  assert.equal(addressMode({ text: "怎么判断是错的", replyingToOther: true, recentWithUser: true }), "skip")
  assert.equal(addressMode({ text: "爱丽丝你看", replyingToOther: true }), "direct")
  assert.equal(addressMode({ text: "是不是在模仿爱丽丝啊" }), "aside")
  assert.equal(addressMode({ text: "爱丽丝会唱歌吗" }), "direct")
  assert.equal(addressMode({ text: "[表情包]", recentWithUser: true }), "skip")
  assert.equal(addressMode({ text: "[表情包]", replyingToHer: true }), "direct")
  assert.equal(namesSomeoneElse("鱼你想要语音功能吗", ["鱼", "爱丽丝"]), true)
  assert.equal(namesSomeoneElse("钓鱼去了", ["鱼"]), false)
  assert.equal(youForOther("你想要语音吗", { self: false, name: "鱼" }), true)
  assert.equal(youForOther("你刚说的是哪句", { self: true, name: "爱丽丝" }), false)
  assert.equal(addressMode({ text: "鱼你想要语音吗", recentWithUser: true, speakerNames: ["鱼"] }), "skip")
  assert.equal(addressMode({ text: "你想要语音吗", recentWithUser: true, previous: { self: false, name: "鱼" } }), "skip")
  assert.equal(addressMode({ text: "你刚说的是哪句", sheJustRepliedToUser: true, previous: { self: true } }), "followup")
  assert.equal(addressMode({ text: "在干嘛", recentWithUser: true, previous: { self: true } }), "followup")
  assert.match(buildPrompt({ text: "是不是在模仿爱丽丝啊", aside: true }), /居然模仿爱丽丝啊/)
  assert.match(buildPrompt({ text: "是不是在模仿爱丽丝啊", aside: true }), /才没有/)
  assert.match(buildPrompt({ text: "在干嘛", followup: true, transcript: "鱼：戳了爱丽丝\n爱丽丝：在的。" }), /别人之间的对话/)
  const quiet = decide(groupEvent([{ type: "text", data: { text: "" } }]), { selfId, trigger: "all" })
  assert.equal(quiet.type, "chat")
  const called = decide(groupEvent([{ type: "at", data: { qq: selfId } }]), { selfId, trigger: "all" })
  assert.equal(called.type, "poke")
  const aside = takeAsides("好[[remember:鱼不喊主人]][[keep:探头]][[voice:老师好]][[silent]]")
  assert.equal(aside.silent, false)
  assert.deepEqual(aside.notes, ["鱼不喊主人"])
  assert.deepEqual(aside.keeps, ["探头"])
  assert.equal(aside.voice, "老师好")
  assert.equal(aside.text.includes("[["), false)
  assert.equal(planVoice("在的。", "老师好", true).speak, "老师好")
  assert.equal(planVoice("老师好", "老师好", true).body, "")
  assert.equal(planVoice("长".repeat(81), "老师好", true).speak, "")
  assert.equal(planVoice("", "老师好", false).speak, "")
  assert.equal(planVoice("", "字".repeat(40), true).speak, "字".repeat(40))
  assert.equal(planVoice("", "字".repeat(41), true).speak, "")
  assert.equal(takeAsides("[[silent]]").silent, true)
  assert.deepEqual(splitBubbles("在的。"), ["在的。"])
  assert.deepEqual(splitBubbles("在的。\n\n再补一句。\n\n第三句"), ["在的。", "再补一句。\n第三句"])
  assert.equal(isReusableSticker({ kind: "mface" }), true)
  assert.equal(isReusableSticker({ kind: "image", subType: "0" }), false)
  assert.equal(faceTitle("「探头张望」。"), "探头张望")
  assert.equal(faceTitle("不知道"), "")
  assert.match(buildLingerPrompt({ persona: "人设", transcript: "爱丽丝：在的", lastLine: "在的" }), /\[\[silent\]\]/)
  assert.equal(formatTranscript([{ name: "鱼", text: "在吗", self: false }, { name: "爱丽丝", text: "在的", self: true }]), "鱼：在吗\n爱丽丝：在的")
  assert.equal(formatTranscript([
    { id: "1", name: "羊", text: "给你两拳", self: false },
    { id: "2", name: "鱼", text: "两拳？", self: false },
  ], "1"), "鱼（更晚）：两拳？")
})

test("占位名不会写进表情袋", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qq-sticker-"))
  const source = path.join(dir, "a.gif")
  await writeFile(source, Buffer.from("GIF89a"))
  const book = new StickerBook(path.join(dir, "book"))
  await book.load()
  const saved = await book.add({ name: "[动画表情]", source, summary: "[动画表情]" })
  assert.equal(saved.name, "表情1")
  assert.equal(book.find("[动画表情]3"), null)
  assert.equal(book.find("表情1")?.id, saved.id)
})

test("access token 放进查询参数且不重复添加", () => {
  assert.equal(withAccessToken("ws://127.0.0.1:3001", "secret").includes("access_token=secret"), true)
  const again = withAccessToken("ws://127.0.0.1:3001/?access_token=kept", "other")
  assert.match(again, /access_token=kept/)
  assert.doesNotMatch(again, /other/)
})

test("会话映射可以写入再读出", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qq-bot-"))
  const store = new SessionStore(path.join(dir, "sessions.json"))
  await store.load()
  await store.set("8:7", { sessionId: "s1", cwd: dir })
  await store.set("8:9", { sessionId: "s2", cwd: dir })
  const reloaded = new SessionStore(path.join(dir, "sessions.json"))
  await reloaded.load()
  assert.deepEqual(reloaded.get("8:7"), { sessionId: "s1", cwd: dir })
  assert.deepEqual(reloaded.get("8:9"), { sessionId: "s2", cwd: dir })
  await reloaded.delete("8:7")
  assert.equal(reloaded.get("8:7"), null)
  assert.deepEqual(reloaded.get("8:9"), { sessionId: "s2", cwd: dir })
})

test("ACP 客户端能收集回复并拒绝工具", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = { stdin, stdout, stderr, kill() {}, once() {}, on() {} }
  const lines = []
  stdin.on("data", (chunk) => lines.push(...chunk.toString("utf8").split("\n").filter(Boolean)))
  const client = new AcpClient({
    command: "fake",
    args: [],
    cwd: process.cwd(),
    toolPolicy: "deny",
    replyTimeoutMs: 1000,
    log() {},
    spawnProcess() { return child },
  })
  const starting = client.start()
  const init = JSON.parse(await nextLine(lines))
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: init.id, result: { agentInfo: { name: "fake-dsh" } } })}\n`)
  await starting

  const prompting = client.prompt("sess", "你好")
  const prompt = JSON.parse(await nextLine(lines))
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "嗨" } } },
  })}\n`)
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 99,
    method: "session/request_permission",
    params: { sessionId: "sess", options: [{ optionId: "reject-once", kind: "reject_once" }] },
  })}\n`)
  const permission = JSON.parse(await nextLine(lines))
  assert.equal(permission.result.outcome.optionId, "reject-once")
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })}\n`)
  const result = await prompting
  assert.equal(result.text, "嗨")
  assert.equal(result.stopReason, "end_turn")
})

test("名单上的机器人两轮后收尾，冷却期内不再接", () => {
  assert.deepEqual(parseBotList("# 注释\n\n12345 某个机器人\nabc\n67890\n"), ["12345", "67890"])
  const now = 1_000_000
  const first = listedBotTurn(undefined, now)
  assert.equal(first.action, "allow")
  assert.equal(first.rounds, 1)
  const second = listedBotTurn(first, now + 1000)
  assert.equal(second.action, "allow")
  assert.equal(second.rounds, 2)
  const third = listedBotTurn(second, now + 2000)
  assert.equal(third.action, "closing")
  assert.equal(third.rounds, 0)
  assert.equal(third.cooldownUntil, now + 2000 + BOT_COOLDOWN_MS)
  assert.equal(BOT_CLOSING, "爱丽丝先去忙了。")
  const during = listedBotTurn(third, third.cooldownUntil - 1)
  assert.equal(during.action, "silent")
  assert.equal(during.cooldownUntil, third.cooldownUntil)
  const after = listedBotTurn(during, third.cooldownUntil)
  assert.equal(after.action, "allow")
  assert.equal(after.rounds, 1)
})

function groupEvent(message, extra = {}) {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 8,
    user_id: 7,
    message_id: 42,
    sender: { nickname: "小王" },
    message,
    ...extra,
  }
}

async function nextLine(lines) {
  for (let i = 0; i < 20; i += 1) {
    if (lines.length > 0) return lines.shift()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("没有等到输出")
}
