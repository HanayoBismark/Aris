import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { buildPrompt } from "../src/chat.js"
import { formatDialogue, MEMORY_TURNS, Memory } from "../src/memory.js"

test("每个人只保留最近 16 句，更早的丢掉", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aris-memory-"))
  const memory = new Memory(path.join(dir, "memory.json"))
  await memory.load()
  for (let index = 0; index < 20; index += 1) {
    await memory.add("8:7", `问${index}`, `答${index}`)
  }
  const turns = memory.recall("8:7")
  assert.equal(turns.length, MEMORY_TURNS)
  assert.equal(turns[0].text, "问12")
  assert.equal(turns.at(-1).text, "答19")
  assert.match(formatDialogue(turns, "小王"), /小王：问12/)
  assert.match(formatDialogue(turns, "小王"), /爱丽丝：答19/)
  assert.equal(formatDialogue([{ role: "assistant", text: "老师在！[[探头]]" }], "小王"), "爱丽丝：老师在！")
  await memory.delete("8:7")
  assert.equal(memory.recall("8:7").length, 0)
})

test("单独对话写进提示，规则仍然只出现一次", () => {
  const prompt = buildPrompt({
    persona: "人设",
    senderName: "小王",
    userId: "7",
    groupName: "测试群",
    groupId: "8",
    text: "还记得吗",
    includePersona: true,
    dialogue: "小王：昨天说好了\n爱丽丝：记得。",
    transcript: "小王：在吗",
  })
  assert.match(prompt, /你和这个人最近说过的话/)
  assert.match(prompt, /小王：昨天说好了/)
  assert.match(prompt, /爱丽丝：记得/)
  assert.equal(prompt.split("不要调用工具").length, 2)
})
