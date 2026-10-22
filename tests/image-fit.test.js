import assert from "node:assert/strict"
import sharp from "sharp"
import test from "node:test"
import { fitForModel } from "../src/image-fit.js"

test("看图前把大图收成不超过 768 像素的 JPEG", async () => {
  const source = await sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 20, b: 20 } },
  }).png().toBuffer()
  const fitted = await fitForModel(source)
  assert.equal(fitted.mimeType, "image/jpeg")
  const meta = await sharp(Buffer.from(fitted.data, "base64")).metadata()
  assert.ok(meta.width <= 768)
  assert.ok(meta.height <= 768)
  assert.equal(meta.format, "jpeg")
})
