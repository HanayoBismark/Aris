import sharp from "sharp"

const MAX_EDGE = 768

export async function fitForModel(bytes) {
  try {
    const fitted = await sharp(bytes, { animated: false, limitInputPixels: false, pages: 1 })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()
    if (fitted.length === 0) return null
    return { mimeType: "image/jpeg", data: fitted.toString("base64") }
  } catch {
    return null
  }
}
