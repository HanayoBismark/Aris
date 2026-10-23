import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { applyProviderPatch } from "../src/provider.js"

test("切换接口时写入对应的 dsh 配置", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "aris-dsh-"))
  const profile = path.join(home, ".dsh", "profiles", "acp")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(profile, { recursive: true })
  await applyProviderPatch({ root: path.resolve("."), homeDir: home, provider: "deepseek" })
  const live = await readFile(path.join(profile, "cordis.patch.yml"), "utf8")
  assert.match(live, /provider: deepseek-official/)
  assert.match(live, /model: deepseek-v4-flash/)
  await applyProviderPatch({ root: path.resolve("."), homeDir: home, provider: "tokenplan" })
  const back = await readFile(path.join(profile, "cordis.patch.yml"), "utf8")
  assert.match(back, /provider: tokenplan/)
  assert.match(back, /TOKENPLAN_API_KEY/)
})
