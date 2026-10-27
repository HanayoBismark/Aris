import assert from "node:assert/strict"
import test from "node:test"
import { gatherSearch, isPublicHttpUrl, selectResults } from "../src/search.js"

const now = new Date("2026-10-23T03:00:00Z")

test("实时查询丢掉百科和内网地址", () => {
  const selected = selectResults([
    { title: "旧闻", url: "https://news.example/old", engine: "bing", publishedDate: "2026-10-22T10:00:00+08:00" },
    { title: "今日金价", url: "https://quote.example/new", engine: "baidu", publishedDate: "2026-10-23T09:00:00+08:00" },
    { title: "百科", url: "https://zh.wikipedia.org/wiki/Gold", engine: "wikipedia", publishedDate: "2026-10-23T09:00:00+08:00" },
    { title: "内网", url: "http://127.0.0.1/secret", engine: "bing", publishedDate: "2026-10-23T09:00:00+08:00" },
  ], { fresh: true, now, maxResults: 5, gold: true })
  assert.deepEqual(selected.map((item) => item.title), ["旧闻", "今日金价"])
  assert.equal(isPublicHttpUrl("http://192.168.1.2/a"), false)
  assert.equal(isPublicHttpUrl("https://quote.example/new"), true)
})

test("两个来源的金价不一致时并列", async () => {
  let calls = 0
  const text = await gatherSearch("查询一下当前黄金价格", {
    apiKey: "tvly-test",
    timeoutMs: 1000,
    maxResults: 5,
    now,
    fetchImpl: async (url, init) => {
      calls += 1
      assert.equal(String(url), "https://api.tavily.com/search")
      const body = JSON.parse(init.body)
      assert.equal(body.topic, "finance")
      assert.equal(body.time_range, "day")
      assert.equal(body.include_answer, false)
      assert.equal(init.headers.authorization, "Bearer tvly-test")
      return jsonResponse({
        results: [
          { title: "金价甲", url: "https://www.sge.com.cn/a", content: "上海金 950.5 元/克", published_date: "2026-10-23" },
          { title: "金价乙", url: "https://www.cngold.org/b", content: "零售价 960.1 元/克", published_date: "2026-10-23" },
        ],
      })
    },
  })
  assert.equal(calls, 1)
  assert.match(text, /950\.5/)
  assert.match(text, /960\.1/)
  assert.match(text, /正文：上海金 950\.5 元\/克/)
  assert.match(text, /不要取平均/)
  assert.match(text, /https:\/\/www\.sge\.com\.cn\/a/)
})

test("搜索服务没连上时不编数字", async () => {
  const text = await gatherSearch("今天金价", {
    apiKey: "tvly-test",
    timeoutMs: 1000,
    fetchImpl: async () => {
      throw new TypeError("fetch failed")
    },
  })
  assert.match(text, /搜索没连上/)
  assert.match(text, /Tavily 未连接/)
  assert.match(text, /不要编数字/)
})

test("没有密钥时不发请求", async () => {
  let calls = 0
  const text = await gatherSearch("今天金价", {
    credentialsFile: "D:\\no\\such\\tavily-credentials.yaml",
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ results: [] })
    },
  })
  assert.equal(calls, 0)
  assert.match(text, /没有 TAVILY_API_KEY/)
})

test("没有正文时不编内容", async () => {
  const text = await gatherSearch("最新新闻", {
    apiKey: "tvly-test",
    timeoutMs: 1000,
    maxResults: 5,
    now,
    fetchImpl: async () => jsonResponse({
      results: [
        { title: "一条新闻", url: "https://news.example/story", content: "", published_date: "2026-10-23" },
      ],
    }),
  })
  assert.match(text, /没有正文/)
  assert.match(text, /https:\/\/news\.example\/story/)
  assert.doesNotMatch(text, /正文：/)
})

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : "" },
    text: async () => JSON.stringify(data),
  }
}
