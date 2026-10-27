#!/usr/bin/env node
// bili-live-gift —— 命令行给 B站 直播间送礼。
//
// 设计原则（不是口号，是实现）：
//   1. 一次只发一个礼物、单价有上限、不给 --go 不发
//   2. 发前读余额、发后回读，差额必须正好等于单价，对不上就报错退出
//   3. 所有写操作有本地额度（每小时/每天/间隔），撞风控就熔断
//
// 用法见 README.md；接口契约见 docs/live-gift.md。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCred, headers, DEFAULT_COOKIE_FILE } from '../src/cred.mjs'
import { createGuard, TrafficPaused } from '../src/guard.mjs'
import { createApi, CODE_HINT } from '../src/api.mjs'
import { loadConfig, CONFIG_FILE, CONFIG_DIR } from '../src/config.mjs'
import { append as ledgerAppend, all as ledgerAll, spentToday, yen, DATA_DIR } from '../src/ledger.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const USER_AGENT = 'bili-live-gift'

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
const opts = new Map()
const rest = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { opts.set(k, next); i++ } else { opts.set(k, 'true') }
  } else {
    rest.push(a)
  }
}
const opt = (k, d = '') => (opts.has(k) ? opts.get(k) : d)
const has = (k) => opts.has(k)
const sub = rest[0]

// ---------------------------------------------------------------- 装配
const cfg = loadConfig()
let cred
function initCred() {
  if (!cred) cred = loadCred({ file: opt('cookie-file') || undefined })
  return cred
}
const guard = createGuard({
  stateFile: path.join(DATA_DIR, 'guard-state.json'),
  writeHourly: cfg.writeHourly,
  writeDaily: cfg.writeDaily,
  writeGapSec: cfg.writeGapSec,
  readGapMs: cfg.readGapMs,
  pauseMs: cfg.pauseMinutes * 60 * 1000,
})
const api = createApi({ cred: { get sessdata() { return initCred().sessdata }, get bili_jct() { return initCred().bili_jct }, get buvid3() { return initCred().buvid3 } }, guard })

const die = (msg, code = 1) => { console.error(msg); process.exit(code) }
const hint = (code) => CODE_HINT[code] ?? CODE_HINT[String(code)] ?? `未收录的错误码，原始响应：${JSON.stringify(code).slice(0, 200)}`

/** 护栏：能不能发这一笔。返回 null 表示没问题 */
function checkBudget(priceGold, budget = {}) {
  const unitYen = Number(priceGold) / 1000
  const limit = budget.dailyLimitYen ?? cfg.dailyLimitYen
  const spent = spentToday()
  if (unitYen > limit) return `单价 ¥${unitYen.toFixed(2)} 已经超过今天的总额 ¥${limit.toFixed(2)}`
  if (spent + unitYen > limit + 1e-9) return `今天已经花 ¥${spent.toFixed(2)} / ¥${limit.toFixed(2)}，这一笔 ¥${unitYen.toFixed(2)} 会超`
  return null
}

// ---------------------------------------------------------------- 子命令
async function cmdWhoami() {
  const n = await api.nav()
  const w = await api.wallet()
  console.log(`我 ${n.uname}（uid=${n.uid}，等级 ${n.level}）`)
  console.log(`金瓜子 ${w.gold}（¥${yen(w.gold)}） · 银瓜子 ${w.silver} · 硬币 ${w.coin}`)
  console.log(`今天已送 ¥${spentToday().toFixed(2)} / ¥${cfg.dailyLimitYen.toFixed(2)}`)
}

async function cmdWallet() {
  const w = await api.wallet()
  console.log(`金瓜子 ${w.gold}（¥${yen(w.gold)}） · 银瓜子 ${w.silver} · 硬币 ${w.coin}`)
  const rows = ledgerAll()
  const ok = rows.filter((r) => r.ok)
  console.log(`流水：共 ${rows.length} 笔（成功 ${ok.length}），今天 ¥${spentToday().toFixed(2)} / ¥${cfg.dailyLimitYen.toFixed(2)}`)
  const g = guard.status()
  console.log(`本地闸门：本小时写 ${g.writeHour}/${cfg.writeHourly} · 今天写 ${g.writeDay}/${cfg.writeDaily}` + (g.pause ? ` · ⛔ 熔断中：${g.pause.reason}（到 ${g.pause.until}）` : ''))
}

async function cmdList() {
  const roomArg = opt('room')
  if (!roomArg) die('用法: bili-live-gift list --room <房间号> [--coin gold] [--max 1]', 2)
  const info = await api.roomInfo(roomArg)
  let rows = await api.giftPanel(info.room)
  const coin = opt('coin', '')
  const maxYen = Number(opt('max', '0'))
  if (coin) rows = rows.filter((r) => r.coin === coin)
  // 银瓜子礼物的 price 字段恒为 0（真价在 roomGiftList 的 silver_list 里），给了 --max 就只留金瓜子
  if (maxYen > 0) rows = rows.filter((r) => r.coin === 'gold' && r.price / 1000 <= maxYen)
  rows.sort((a, b) => a.price - b.price)
  console.log(`房间 ${info.room}（${info.title}）礼物 ${rows.length} 个${maxYen > 0 ? `（金瓜子 ≤¥${maxYen}）` : ''}：`)
  for (const r of rows.slice(0, 40)) {
    const cost = r.coin === 'gold' ? `${yen(r.price).padStart(9)} 元` : '       银瓜子'
    console.log(`  ${String(r.id).padEnd(7)} ${r.coin === 'gold' ? '金' : '银'} ${cost}  ${r.name}`)
  }
  if (rows.length > 40) console.log(`  …… 还有 ${rows.length - 40} 个，用 --max 收窄`)
  console.log(`\n送礼：bili-live-gift send --room ${info.room} --gift <id> --go（一次一笔，单价上限 ¥${yen(cfg.maxUnitPriceGold)}，改上限要去改配置）`)
}

async function cmdBag() {
  const roomArg = opt('room')
  if (!roomArg) die('用法: bili-live-gift bag --room <房间号>', 2)
  const info = await api.roomInfo(roomArg)
  const list = await api.bagList(info.room)
  if (!list.length) { console.log('背包是空的（免费礼物只在活动期间发，平时没有）。'); return }
  console.log(`房间 ${info.room}（${info.title}）背包 ${list.length} 个：`)
  for (const it of list) {
    const g = it.gift_info ?? it.giftInfo ?? {}
    console.log(`  bag_id=${it.bag_id ?? it.bagId ?? '?'}  gift_id=${g.gift_id ?? g.giftId ?? '?'}  ${g.gift_name ?? g.giftName ?? ''}  有效期至 ${it.expire_at ?? it.expireAt ?? '?'}`)
  }
  console.log(`\n送出：bili-live-gift claim --room ${info.room} --gift <gift_id> --bag <bag_id> --go`)
}

async function cmdClaim() {
  const roomArg = opt('room'); const giftArg = opt('gift'); const bagArg = opt('bag')
  if (!roomArg || !giftArg || !bagArg) die('用法: bili-live-gift claim --room <房间号> --gift <礼物id> --bag <背包id> [--dry|--go]', 2)
  const n = await api.nav()
  const info = await api.roomInfo(roomArg)
  console.log('=== 背包送礼预检 ===')
  console.log(`  房间 ${info.room}（${info.title}）主播 uid=${info.anchor}  我 uid=${n.uid}`)
  console.log(`  背包礼物 gift_id=${giftArg} bag_id=${bagArg} ×1  → 不动金瓜子余额`)
  if (!has('go')) { console.log('\n[dry] 预检通过，未发送。把 --dry 换成 --go 才会真发。'); return }

  const before = await api.wallet()
  const { kind, res } = await api.sendGift({ room: info.room, anchor: info.anchor, giftId: Number(giftArg), giftNum: 1, coin: 'gold', bagId: bagArg, price: 0, uid: n.uid, images: n.images })
  console.log(`\n[go] POST ${kind} → code=${res.code} ${res.message ?? ''}`)
  ledgerAppend({ at: Date.now(), ok: res.code === 0, code: res.code, kind: 'bag', room: info.room, anchor: info.anchor, gift_id: Number(giftArg), bag_id: bagArg, num: 1, price_gold: 0 })
  if (res.code !== 0) { console.log(`  ${hint(res.code)}`); process.exit(4) }
  const after = await api.wallet()
  console.log(`  复核余额：${before.gold} → ${after.gold}（背包礼物应该不动金瓜子）${before.gold === after.gold ? ' ✓' : ' ⚠️ 金瓜子变了，检查一下'}`)
}

async function cmdSend() {
  const roomArg = opt('room'); const giftArg = opt('gift'); const num = Number(opt('num', '1'))
  if (!roomArg || !giftArg) die('用法: bili-live-gift send --room <房间号> --gift <礼物id> [--num 1] [--dry|--go]', 2)
  if (num !== 1) die('✗ 只允许 gift_num=1（一次授权只做一笔）', 3)

  const n = await api.nav()
  const info = await api.roomInfo(roomArg)
  const panel = await api.giftPanel(info.room)
  const g = panel.find((x) => String(x.id) === String(giftArg))
  if (!g) die(`✗ 礼物面板里没有 id=${giftArg}（先 list --room ${info.room}）`, 3)
  if (g.coin !== 'gold') die(`✗ 只支持金瓜子礼物；「${g.name}」是 ${g.coin}`, 3)
  if (g.price <= 0) die(`✗ 「${g.name}」price=0，是「发红包/游戏道具」这类特殊礼物，参数不一样，本工具不碰`, 3)
  if (g.price > cfg.maxUnitPriceGold) {
    die(`✗ 「${g.name}」单价 ¥${yen(g.price)} 超过上限 ¥${yen(cfg.maxUnitPriceGold)}（想改就改 ${CONFIG_FILE} 的 maxUnitPriceGold，别用命令行放开）`, 3)
  }

  const w = await api.wallet()
  console.log('=== 送礼预检 ===')
  console.log(`  房间 ${info.room}（${info.title}）主播 uid=${info.anchor}  ${info.live ? '直播中' : '未开播'}`)
  console.log(`  我 ${n.uname} uid=${n.uid}  余额 ${w.gold} 金瓜子（¥${yen(w.gold)}）`)
  console.log(`  礼物「${g.name}」 id=${g.id} ×1  单价 ${g.price} 金瓜子 = ¥${yen(g.price)}`)
  console.log(`  今天已送 ¥${spentToday().toFixed(2)} / ¥${cfg.dailyLimitYen.toFixed(2)}`)

  if (w.gold < g.price) die(`✗ 余额不足：${w.gold} < ${g.price}`, 3)
  const budgetErr = checkBudget(g.price)
  if (budgetErr) die(`✗ ${budgetErr}`, 3)
  if (!has('go')) { console.log('\n[dry] 预检通过，未发送。把 --dry 换成 --go 才会真发（一次一笔）。'); return }

  const before = w.gold
  const { kind, res } = await api.sendGift({ room: info.room, anchor: info.anchor, giftId: g.id, giftNum: 1, coin: 'gold', price: g.price, uid: n.uid, images: n.images })
  console.log(`\n[go] POST ${kind} → code=${res.code} ${res.message ?? ''}`)
  if (res.code !== 0) {
    console.log(`  ${hint(res.code)}`)
    ledgerAppend({ at: Date.now(), ok: false, code: res.code, kind: 'gold', room: info.room, anchor: info.anchor, gift_id: g.id, gift_name: g.name, num: 1, price_gold: g.price })
    process.exit(4)
  }

  // 对账：金瓜子必须正好少 price。不看返回码就信它，是这类工具最常见的错。
  await new Promise((r) => setTimeout(r, 2500))
  const after = await api.wallet()
  const delta = Number(before) - Number(after.gold)
  const ok = delta === g.price
  console.log(`  对账：余额 ${before} → ${after.gold}，差额 ${delta}（应等于 ${g.price}）${ok ? ' ✓' : ' ✗ 对不上'}`)
  ledgerAppend({ at: Date.now(), ok, code: res.code, kind: 'gold', room: info.room, anchor: info.anchor, gift_id: g.id, gift_name: g.name, num: 1, price_gold: g.price, delta })
  if (!ok) {
    console.log('  ⚠️ 差额对不上：可能没扣、扣多了、或者余额还没刷新。别连续重试，先看流水（log）')
    process.exit(5)
  }
}

async function cmdMedal() {
  const medals = await api.medals()
  console.log(`我的粉丝牌 ${medals.length} 个`)
  const roomArg = opt('room')
  if (roomArg) {
    const info = await api.roomInfo(roomArg)
    const hit = medals.find((x) => String(x.target_id) === String(info.anchor))
    if (hit) {
      console.log(`  房间 ${info.room}（${info.title}）主播 ${hit.target_name || info.anchor}：牌「${hit.medal_name}」Lv${hit.level}`)
      console.log(`  亲密度 ${hit.intimacy}/${hit.next_intimacy} · 今日已喂 ${hit.today_feed ?? 0}/${hit.day_limit ?? 0}`)
    } else {
      console.log(`  房间 ${info.room}（${info.title}）还没有这家的牌（投喂或上舰才有；上舰本工具不做）`)
    }
  }
  for (const x of medals.slice(0, 12)) {
    console.log(`  ${String(x.medal_name ?? '?').padEnd(9)} Lv${String(x.level ?? '?').padEnd(3)} 亲密度 ${x.intimacy ?? '?'}/${x.next_intimacy ?? '?'}  今日 ${x.today_feed ?? 0}/${x.day_limit ?? 0}  主播 ${x.target_name || x.target_id}`)
  }
}

function cmdLog() {
  const rows = ledgerAll().slice(-Number(opt('n', '20'))).reverse()
  if (!rows.length) { console.log('还没有送礼流水。'); return }
  for (const r of rows) {
    const t = new Date(r.at).toLocaleString('zh-CN', { hour12: false })
    const what = r.bag_id ? `背包礼物 gift_id=${r.gift_id}（bag_id=${r.bag_id}）` : `「${r.gift_name ?? '?'}」×${r.num ?? 1}`
    console.log(`${t}  ${r.ok ? '✓' : `✗ code=${r.code}`}  房间 ${r.room}  ${what}${r.ok ? `  ¥${yen((r.price_gold ?? 0) * (r.num ?? 1))}` : ''}`)
  }
}

function cmdStats() {
  const rows = ledgerAll()
  const ok = rows.filter((r) => r.ok)
  if (!ok.length) { console.log('还没有成功的送礼记录。'); return }
  const byRoom = new Map(); const byGift = new Map()
  let total = 0
  for (const r of ok) {
    const money = Number(r.price_gold ?? 0) * Number(r.num ?? 1) / 1000
    total += money
    const rk = String(r.room)
    byRoom.set(rk, (byRoom.get(rk) ?? 0) + money)
    const gk = r.gift_name ?? `gift_id=${r.gift_id}`
    byGift.set(gk, (byGift.get(gk) ?? 0) + money)
  }
  const show = (m, title) => {
    console.log(title)
    for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ¥${v.toFixed(2)}`)
  }
  console.log(`成功送礼 ${ok.length} 笔，共 ¥${total.toFixed(2)}${rows.length !== ok.length ? `（另有 ${rows.length - ok.length} 笔失败）` : ''}`)
  show(byRoom, '\n按房间：')
  show(byGift, '\n按礼物：')
}

function cmdBudget() {
  console.log(`今天已送 ¥${spentToday().toFixed(2)} / ¥${cfg.dailyLimitYen.toFixed(2)}（北京时区 0 点归零）`)
}

function cmdConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
  if (fs.existsSync(CONFIG_FILE)) { console.log(`配置已存在：${CONFIG_FILE}`); console.log(fs.readFileSync(CONFIG_FILE, 'utf8')); return }
  fs.writeFileSync(CONFIG_FILE, json_example())
  console.log(`已写入默认配置：${CONFIG_FILE}`)
  console.log(`cookie 请放：${DEFAULT_COOKIE_FILE}（{"sessdata":"...","bili_jct":"..."}）`)
}

function json_example() {
  return `${JSON.stringify({ maxUnitPriceGold: cfg.maxUnitPriceGold, dailyLimitYen: cfg.dailyLimitYen, writeHourly: cfg.writeHourly, writeDaily: cfg.writeDaily, writeGapSec: cfg.writeGapSec, readGapMs: cfg.readGapMs, pauseMinutes: cfg.pauseMinutes }, null, 2)}\n`
}

function cmdHelp() {
  console.log(`${USER_AGENT} —— 给 B站 直播间送礼（自己的号、自己的钱、一次一笔）

用法:
  bili-live-gift whoami                      我是谁 + 余额 + 今天花了多少
  bili-live-gift wallet                      余额 + 流水 + 本地闸门状态
  bili-live-gift list --room R [--max 1]     礼物面板（按价格排序；--max 只保留 ≤¥N 的金瓜子礼物）
  bili-live-gift bag  --room R               背包礼物（免费/活动直购）
  bili-live-gift claim --room R --gift ID --bag BID [--go]
                                             把背包礼物送出去（不动金瓜子）
  bili-live-gift send --room R --gift ID --dry      只预检
  bili-live-gift send --room R --gift ID --go       真发（一次一个）
  bili-live-gift medal [--room R]            我的粉丝牌 / 亲密度
  bili-live-gift log [--n 20]                流水
  bili-live-gift stats                       按房间/礼物汇总
  bili-live-gift budget                      今天还能花多少
  bili-live-gift config                      生成默认配置

配置: ${CONFIG_FILE}
cookie: 环境变量 BILI_SESSDATA / BILI_JCT，或 ${DEFAULT_COOKIE_FILE}
接口契约: docs/live-gift.md

护栏（硬编码，绕不过）:
  · 一次只能 1 个礼物；单价上限 ¥${yen(cfg.maxUnitPriceGold)}（配置里改）
  · 不给 --go 绝不发送；每天上限 ¥${cfg.dailyLimitYen}
  · 发前读余额、发后回读对账，差额不对就报错退出
  · 写操作有本地额度与间隔，撞 412 自动熔断
`)
}

const table = {
  whoami: cmdWhoami, wallet: cmdWallet, list: cmdList, bag: cmdBag, claim: cmdClaim,
  send: cmdSend, medal: cmdMedal, log: cmdLog, stats: cmdStats, budget: cmdBudget,
  config: cmdConfig, help: cmdHelp,
}

if (!sub || sub === '-h' || sub === '--help' || sub === 'help') { cmdHelp(); process.exit(0) }
if (!table[sub]) { die(`未知子命令：${sub}\n\n（bili-live-gift help 看全部）`, 2) }

try {
  await table[sub]()
} catch (e) {
  if (e instanceof TrafficPaused) die(`⛔ ${e.message}`, 6)
  die(`✗ ${e?.message ?? e}`, 6)
}
