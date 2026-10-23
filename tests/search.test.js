import assert from "node:assert/strict"
import test from "node:test"
import { gatherSearch, isPublicHttpUrl, selectResults } from "../src/search.js"

const now = new Date("2026-10-23T03:00:00Z")

test("实时查询丢掉百科和不是今天的结果", () => {
  const selected = selectResults([
    { title: "旧闻", url: "https://news.example/old", engine: "bing", publishedDate: "2026-10-22T10:00:00+08:00" },
    { title: "今日金价", url: "https://quote.example/new", engine: "baidu", publishedDate: "2026-10-23T09:00:00+08:00" },
    { title: "百科", url: "https://zh.wikipedia.org/wiki/Gold", engine: "wikipedia", publishedDate: "2026-10-23T09:00:00+08:00" },
    { title: "内网", url: "http://127.0.0.1/secret", engine: "bing", publishedDate: "2026-10-23T09:00:00+08:00" },
  ], { fresh: true, now, maxResults: 5, gold: true })
  assert.deepEqual(selected.map((item) => item.title), ["今日金价"])
  assert.equal(isPublicHttpUrl("http://192.168.1.2/a"), false)
  assert.equal(isPublicHttpUrl("https://quote.example/new"), true)
})

test("两个引擎的金价不一致时并列", async () => {
  const text = await gatherSearch("查询一下当前黄金价格", {
    searxngUrl: "http://127.0.0.1:8088",
    timeoutMs: 1000,
    maxResults: 5,
    fetchPages: 2,
    now,
    fetchImpl: async (url) => {
      const target = String(url)
      if (target.includes("/search")) {
        assert.match(target, /time_range=day/)
        return jsonResponse({
          results: [
            { title: "金价甲", url: "https://news.example/a", content: "摘要甲", publishedDate: "2026-10-23T08:00:00+08:00", engine: "bing" },
            { title: "金价乙", url: "https://quote.example/b", content: "摘要乙", publishedDate: "2026-10-23T08:30:00+08:00", engine: "baidu" },
          ],
        })
      }
      if (target.includes("news.example")) return htmlResponse("<p>950.5 元/克</p>")
      if (target.includes("quote.example")) return htmlResponse("<p>960.1 元/克</p>")
      throw new Error(`意外的请求 ${target}`)
    },
  })
  assert.match(text, /950\.5/)
  assert.match(text, /960\.1/)
  assert.match(text, /不要取平均/)
  assert.match(text, /https:\/\/news\.example\/a/)
})

test("搜索服务没连上时不编数字", async () => {
  const text = await gatherSearch("今天金价", {
    searxngUrl: "http://127.0.0.1:8088",
    timeoutMs: 1000,
    fetchImpl: async () => {
      throw new TypeError("fetch failed")
    },
  })
  assert.match(text, /搜索没连上/)
  assert.match(text, /不要编数字/)
})

test("打不开的页面标成未核实", async () => {
  const text = await gatherSearch("最新新闻", {
    searxngUrl: "http://127.0.0.1:8088",
    timeoutMs: 1000,
    fetchPages: 2,
    now,
    fetchImpl: async (url) => {
      if (String(url).includes("/search")) {
        return jsonResponse({
          results: [
            { title: "一条新闻", url: "https://news.example/story", content: "摘要里的 123 元/克", publishedDate: "2026-10-23T08:00:00+08:00", engine: "bing news" },
          ],
        })
      }
      return { ok: false, status: 500, headers: { get: () => "" }, text: async () => "" }
    },
  })
  assert.match(text, /未核实/)
  assert.doesNotMatch(text, /页面正文里的数字：123/)
})

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : "" },
    text: async () => JSON.stringify(data),
  }
}

function htmlResponse(html) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "text/html" : "" },
    text: async () => html,
  }
}
