// WBI 签名：B站 web 端所有 xlive 写接口都要这两个参数（wts + w_rid）。
//
// 密钥不是常量，来自 https://api.bilibili.com/x/web-interface/nav 的 data.wbi_img，
// 即 img_url 与 sub_url 的文件名（去掉目录和扩展名）拼起来的 64 字符，按固定的
// MIXIN 表重排后取前 32 位。这是社区从 web 端 bundle 里还原出来的算法
// （参见 bilibili-API-collect 与各 userscript），本文件是独立实现，没有拷贝它们的代码。
import crypto from 'node:crypto'

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

const basename = (u) => String(u ?? '').split('/').pop().split('.')[0]

/** 从 nav 的 wbi_img 算出 32 位密钥 */
export function wbiKey(images) {
  const raw = basename(images?.img_url) + basename(images?.sub_url)
  if (raw.length !== 64) throw new Error('拿不到 WBI 密钥（wbi_img 不完整），通常是没登录或 nav 被风控')
  return MIXIN.map((i) => raw[i]).join('').slice(0, 32)
}

/**
 * 生成带 w_rid 的完整 query 串（不含前导 ?）。
 * params 里的值为 null/undefined 会被跳过；w_rid 会被重算。
 */
export function signWbi(params, images, now = Date.now()) {
  const key = wbiKey(images)
  const values = {}
  for (const [k, v] of Object.entries(params)) if (v != null) values[k] = String(v)
  values.wts = String(Math.floor(now / 1000))
  delete values.w_rid
  const query = Object.keys(values).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(values[k].replace(/[!'()*]/g, ''))}`)
    .join('&')
  const w_rid = crypto.createHash('md5').update(query + key).digest('hex')
  return `${query}&w_rid=${w_rid}`
}
