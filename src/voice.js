import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

export function createVoice({ config, dir, log }) {
  let chain = Promise.resolve()
  let ready = false
  let preparing = null

  async function ensure() {
    if (!config?.enabled) throw new Error("语音未启用")
    if (!config.refAudio || !config.gptWeights || !config.sovitsWeights) throw new Error("语音配置不完整")
    if (ready) return
    if (!preparing) {
      preparing = (async () => {
        await switchWeights("/set_gpt_weights", config.gptWeights)
        await switchWeights("/set_sovits_weights", config.sovitsWeights)
        ready = true
        log("语音模型已装上")
      })().finally(() => {
        if (!ready) preparing = null
      })
    }
    return preparing
  }

  async function switchWeights(pathname, weights) {
    const url = new URL(pathname, `${config.baseUrl}/`)
    url.searchParams.set("weights_path", weights)
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error((await response.text()).slice(0, 200) || `切换模型失败 ${response.status}`)
  }

  async function once(text) {
    await ensure()
    const response = await fetch(new URL("/tts", `${config.baseUrl}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        text_lang: config.textLang || "zh",
        ref_audio_path: config.refAudio,
        prompt_text: config.promptText,
        prompt_lang: config.promptLang || "ja",
        text_split_method: "cut0",
        batch_size: 1,
        media_type: "wav",
        streaming_mode: false,
        speed_factor: config.speedFactor,
      }),
      signal: AbortSignal.timeout(45000),
    })
    const type = response.headers.get("content-type") ?? ""
    if (!response.ok || !type.includes("audio")) {
      throw new Error((await response.text()).slice(0, 200) || `语音接口 ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 44) throw new Error("语音是空的")
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}.wav`)
    await writeFile(file, bytes)
    return file
  }

  function synthesize(text) {
    const run = chain.then(() => once(text))
    chain = run.catch(() => {})
    return run
  }

  return {
    enabled: Boolean(config?.enabled),
    warm() {
      return ensure().catch((error) => {
        ready = false
        log(`语音服务还没就绪：${error.message}`)
      })
    },
    synthesize,
  }
}

export function recordUrl(file) {
  return `file:///${path.resolve(file).replace(/\\/g, "/")}`
}
