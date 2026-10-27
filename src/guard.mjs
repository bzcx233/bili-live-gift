// 本地闸门：防手抖，也防把号送进风控。
//
// 三样东西：最小间隔、每小时/每天写操作条数、撞到 412/风控就熔断一段时间。
// 状态存在本地 json 里，进程重启也记得住 —— 否则跑三次脚本就等于没有限额。
import fs from 'node:fs'
import path from 'node:path'

export class TrafficPaused extends Error {
  constructor(msg, until) {
    super(msg)
    this.name = 'TrafficPaused'
    this.code = 'PAUSED'
    this.until = until
  }
}

const RISK_CODES = new Set([-412, -352, -401, 412, 601])

const hourKey = () => new Date().toISOString().slice(0, 13) // 粗略的小时桶
const dayKey = () => new Date().toISOString().slice(0, 10)

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

function writeState(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, file)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

/**
 * @param {object} o
 * @param {string} o.stateFile
 * @param {number} [o.writeHourly]  每小时允许多少条写操作
 * @param {number} [o.writeDaily]   每天允许多少条
 * @param {number} [o.writeGapSec]  两条写之间的最小间隔（秒）
 * @param {number} [o.readGapMs]    两条读之间的最小间隔（毫秒）
 * @param {number} [o.pauseMs]      撞风控后熔断多久
 */
export function createGuard(o) {
  const stateFile = o.stateFile
  const cfg = {
    writeHourly: o.writeHourly ?? 12,
    writeDaily: o.writeDaily ?? 60,
    writeGapMs: (o.writeGapSec ?? 120) * 1000,
    readGapMs: o.readGapMs ?? 1500,
    pauseMs: o.pauseMs ?? 2 * 3600 * 1000,
  }

  function load() {
    const s = readState(stateFile)
    const hour = hourKey(); const day = dayKey()
    if (s.hour !== hour) { s.hour = hour; s.writeHour = 0; s.readHour = 0 }
    if (s.day !== day) { s.day = day; s.writeDay = 0; s.readDay = 0 }
    return s
  }

  function blockedReason(s, now) {
    if (s.pausedUntil && s.pausedUntil > now) {
      return `撞过风控（${s.pauseReason || '412'}），熔断到 ${fmt(s.pausedUntil)}`
    }
    return null
  }

  /**
   * 所有请求都从这里走。写操作（送礼）必须先通过额度检查。
   * @param {string} url
   * @param {object} init fetch init
   * @param {{write?: boolean, label?: string}} opt
   */
  async function guardedFetch(url, init = {}, opt = {}) {
    const write = !!opt.write
    const s = load()
    const now = Date.now()

    const paused = blockedReason(s, now)
    if (paused) throw new TrafficPaused(paused, s.pausedUntil)

    if (write) {
      if (s.writeHour >= cfg.writeHourly) {
        throw new TrafficPaused(`本小时写操作已满 ${cfg.writeHourly} 条，等下一个整点。这是本地闸门，不是被封号`, null)
      }
      if (s.writeDay >= cfg.writeDaily) {
        throw new TrafficPaused(`今天写操作已满 ${cfg.writeDaily} 条，明天再来。这是本地闸门，不是被封号`, null)
      }
      const since = now - (s.lastWrite ?? 0)
      if (since < cfg.writeGapMs) {
        const wait = cfg.writeGapMs - since
        throw new TrafficPaused(`两条写操作之间至少要隔 ${Math.round(cfg.writeGapMs / 1000)} 秒，还要等 ${Math.ceil(wait / 1000)} 秒`, now + wait)
      }
    } else {
      const since = now - (s.lastRead ?? 0)
      if (since < cfg.readGapMs) await sleep(cfg.readGapMs - since)
    }

    const res = await fetch(url, init)
    const now2 = Date.now()
    const s2 = load()
    if (write) {
      s2.lastWrite = now2
      s2.writeHour = (s2.writeHour ?? 0) + 1
      s2.writeDay = (s2.writeDay ?? 0) + 1
    } else {
      s2.lastRead = now2
      s2.readHour = (s2.readHour ?? 0) + 1
    }
    s2.lastEndpoint = url.replace(/https:\/\/[^/]+/, '').split('?')[0]
    s2.lastStatus = res.status

    if (res.status === 412) {
      s2.pausedUntil = now2 + cfg.pauseMs
      s2.pauseReason = 'HTTP 412（请求被 B站 拦了）'
      writeState(stateFile, s2)
      throw new TrafficPaused(`B站 回了 412，熔断到 ${fmt(s2.pausedUntil)}。别再试，越试越久`, s2.pausedUntil)
    }
    writeState(stateFile, s2)
    return res
  }

  /** 业务码层面的风控信号（有些风控回的是 200 + 特殊 code） */
  function noteCode(code, label) {
    if (!RISK_CODES.has(Number(code))) return
    const s = load()
    s.pausedUntil = Date.now() + cfg.pauseMs
    s.pauseReason = `接口 ${label ?? ''} 回了 ${code}`
    writeState(stateFile, s)
  }

  function status() {
    const s = load()
    return { ...cfg, pause: s.pausedUntil && s.pausedUntil > Date.now() ? { until: fmt(s.pausedUntil), reason: s.pauseReason } : null,
      writeHour: s.writeHour ?? 0, writeDay: s.writeDay ?? 0, readHour: s.readHour ?? 0, lastWrite: s.lastWrite ? fmt(s.lastWrite) : null }
  }

  return { guardedFetch, noteCode, status, stateFile }
}
