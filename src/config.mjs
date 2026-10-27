// 配置。一个 json 文件，缺省值写在 DEFAULTS 里，改哪项写哪项。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'bili-live-gift')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export const DEFAULTS = {
  /** 单笔礼物单价上限（金瓜子）。1000 = ¥1.00。想送贵的要自己把这里改大 —— 故意不用命令行参数放开 */
  maxUnitPriceGold: 1000,
  /** 每天最多花多少元（按成功流水算，北京时区零点归零） */
  dailyLimitYen: 20,
  /** 每小时最多几条写操作（送礼/查余额之外的写请求） */
  writeHourly: 12,
  /** 每天最多几条写操作 */
  writeDaily: 60,
  /** 两条写操作之间最小间隔（秒） */
  writeGapSec: 120,
  /** 两条读之间最小间隔（毫秒） */
  readGapMs: 1500,
  /** 撞 412 熔断多久（分钟） */
  pauseMinutes: 120,
}

export function loadConfig(file = CONFIG_FILE) {
  let user = {}
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`配置文件不是合法 JSON：${file}（${e.message}）`)
    }
  }
  return { ...DEFAULTS, ...user, file }
}
