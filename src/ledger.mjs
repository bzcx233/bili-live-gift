// 流水 + 每日预算。没有数据库，就是一个人能看懂、能 diff 的 jsonl。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DATA_DIR = process.env.BILI_LIVE_GIFT_DATA || path.join(os.homedir(), '.local', 'share', 'bili-live-gift')
export const LEDGER = path.join(DATA_DIR, 'ledger.jsonl')

/** 北京时区算「今天」—— B站的日榜、亲密度上限都是按北京时间零点刷新的 */
export function bjDay(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

export function append(row) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n')
  } catch (e) {
    console.error(`⚠️ 流水没写进去（不影响发送结果）：${e.message}`)
  }
}

export function all() {
  try {
    return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 今天已经花掉多少元（只算成功的） */
export function spentToday(ts = Date.now()) {
  const day = bjDay(ts)
  let sum = 0
  for (const r of all()) {
    if (!r.ok) continue
    if (bjDay(r.at ?? 0) !== day) continue
    sum += Number(r.price_gold ?? 0) * Number(r.num ?? 1) / 1000
  }
  return Math.round(sum * 100) / 100
}

export const yen = (gold) => (Number(gold) / 1000).toFixed(2)
