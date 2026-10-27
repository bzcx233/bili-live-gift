// 读 cookie。三种方式，优先级从高到低：
//   1. 环境变量 BILI_SESSDATA / BILI_JCT / BILI_BUVID3
//   2. --cookie-file <path>，或环境变量 BILI_COOKIE_FILE
//   3. 默认路径 ~/.config/bili-live-gift/cookies.json
//
// 文件格式（也兼容 dsh-bili-whale / 各类脚本的写法）：
//   { "sessdata": "...", "bili_jct": "...", "buvid3": "..." }
//   { "SESSDATA": "...", "bili_jct": "...", "buvid3": "..." }
//
// 注意：SESSDATA 等于账号的登录态，拿到它就能以你的身份操作。别提交、别截图、别贴群。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_COOKIE_FILE = path.join(os.homedir(), '.config', 'bili-live-gift', 'cookies.json')

function pick(obj, names) {
  for (const n of names) {
    const v = obj?.[n]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * @param {{file?: string, required?: string[]}} opts required 里缺哪个就报哪个
 */
export function loadCred(opts = {}) {
  const env = process.env
  let fromFile = {}
  const file = opts.file || env.BILI_COOKIE_FILE || DEFAULT_COOKIE_FILE
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`cookie 文件不是合法 JSON：${file}（${e.message}）`)
    }
  }
  const cred = {
    sessdata: env.BILI_SESSDATA?.trim() || pick(fromFile, ['sessdata', 'SESSDATA', 'sessData']),
    bili_jct: env.BILI_JCT?.trim() || pick(fromFile, ['bili_jct', 'biliJct', 'csrf', 'csrf_token']),
    buvid3: env.BILI_BUVID3?.trim() || pick(fromFile, ['buvid3', 'BUVID3']),
    file,
  }
  const need = opts.required ?? ['sessdata', 'bili_jct']
  const missing = need.filter((k) => !cred[k])
  if (missing.length) {
    throw new Error(
      `缺少 ${missing.join(' / ')}。三种给法：\n` +
      `  ① 环境变量 BILI_SESSDATA + BILI_JCT（+ BILI_BUVID3）\n` +
      `  ② --cookie-file <path>\n` +
      `  ③ 写进 ${DEFAULT_COOKIE_FILE}：{"sessdata":"...","bili_jct":"..."}\n` +
      `bili_jct 是浏览器 cookie 里那个 32 位 hex；从浏览器 F12 → Application → Cookies 复制。`,
    )
  }
  return cred
}

/** cookie 头 + 直播站需要的 referer/origin */
export function headers(cred, room) {
  const h = {
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}`,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept-language': 'zh-CN,zh;q=0.9',
  }
  if (room) {
    h.referer = `https://live.bilibili.com/${room}`
    h.origin = 'https://live.bilibili.com'
  }
  return h
}
