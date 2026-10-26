import assert from "node:assert/strict"
import test from "node:test"
import { deltaFromLine, endpointFor, ModelClient, readCredential, toContent } from "../src/model.js"

test("三个接口各自指向原来的地址和模型", () => {
  assert.equal(endpointFor("qwen").baseURL, "http://127.0.0.1:18080/v1")
  assert.match(endpointFor("qwen").model, /Qwen3\.5-122B-A10B-6bit/)
  assert.equal(endpointFor("deepseek").baseURL, "https://api.deepseek.com/v1")
  assert.equal(endpointFor("deepseek").model, "deepseek-v4-flash")
  assert.equal(endpointFor("tokenplan").model, "deepseek-v4.1-flash-1017")
  assert.equal(endpointFor("其他").model, endpointFor("tokenplan").model)
})

test("从凭证文件读出指定的键", () => {
  const text = "envs:\n  QWEN_API_KEY: local\n  DEEPSEEK_API_KEY: secret-value\n"
  assert.equal(readCredential(text, "QWEN_API_KEY"), "local")
  assert.equal(readCredential(text, "DEEPSEEK_API_KEY"), "secret-value")
  assert.equal(readCredential(text, "MISSING"), "")
})

test("图片转成数据地址，文字保持原样", () => {
  assert.equal(toContent("你好"), "你好")
  assert.deepEqual(toContent([
    { type: "image", mimeType: "image/png", data: "abc" },
    { type: "text", text: "看这张" },
  ]), [
    { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    { type: "text", text: "看这张" },
  ])
})

test("流式增量只取正文", () => {
  assert.equal(deltaFromLine("data: [DONE]"), "")
  assert.equal(deltaFromLine('data: {"choices":[{"delta":{"content":"嗨"}}]}'), "嗨")
  assert.equal(deltaFromLine('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}'), "")
  assert.equal(deltaFromLine("不是数据"), "")
})

test("流式回复能拼回正文并记下首字", async () => {
  const client = new ModelClient({
    provider: "qwen",
    replyTimeoutMs: 1000,
    credentialsFile: "missing",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.equal(body.model, endpointFor("qwen").model)
      assert.equal(body.stream, true)
      assert.equal(body.messages[0].content, "你好")
      assert.match(init.headers.authorization, /^Bearer /)
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"在"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"的"}}]}\n\n',
        "data: [DONE]\n",
      ])
    },
  })
  const result = await client.complete("8:7", "你好")
  assert.equal(result.text, "在的")
  assert.ok(result.ttftMs >= 0)
  assert.ok(result.elapsedMs >= result.ttftMs)
})

test("取消进行中的请求", async () => {
  const client = new ModelClient({
    provider: "qwen",
    replyTimeoutMs: 5000,
    credentialsFile: "missing",
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    }),
  })
  const pending = client.complete("8:7", "你好")
  await new Promise((resolve) => setTimeout(resolve, 20))
  client.cancel("8:7")
  await assert.rejects(pending, /已取消/)
})

function sseResponse(lines) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}
