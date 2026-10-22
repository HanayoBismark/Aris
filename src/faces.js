export const FACE_BY_NAME = {
  惊讶: "0",
  撇嘴: "1",
  发呆: "3",
  得意: "4",
  流泪: "5",
  害羞: "6",
  大哭: "9",
  尴尬: "10",
  调皮: "12",
  呲牙: "13",
  微笑: "14",
  难过: "15",
  偷笑: "20",
  可爱: "21",
  白眼: "22",
  疑问: "32",
  再见: "39",
  赞: "76",
  擦汗: "97",
  抠鼻: "98",
  鼓掌: "99",
  糗大了: "100",
  坏笑: "101",
  委屈: "106",
  快哭了: "107",
  可怜: "111",
  吃瓜: "271",
  汪汪: "277",
  喵喵: "307",
  加油: "315",
  比心: "319",
}

export const FACE_BY_ID = Object.fromEntries(Object.entries(FACE_BY_NAME).map(([name, id]) => [id, name]))

export const FACE_HINT = "微笑、得意、发呆、流泪、害羞、可爱、坏笑、疑问、委屈、可怜、赞、汪汪、吃瓜、喵喵、加油、比心"

export function resolveFace(token) {
  const text = String(token ?? "").trim().replace(/^\//, "")
  if (FACE_BY_NAME[text]) return FACE_BY_NAME[text]
  if (FACE_BY_ID[text]) return text
  return ""
}

export function faceName(id) {
  return FACE_BY_ID[String(id ?? "")] ?? ""
}
