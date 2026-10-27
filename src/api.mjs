// 直播站接口封装。每个函数的返回值都是 B站 的原始 JSON（code/message/data），不做隐藏。
import { signWbi } from './wbi.mjs'
import { headers } from './cred.mjs'

const LIVE = 'https://api.live.bilibili.com'
const MAIN = 'https://api.bilibili.com'

export function createApi({ cred, guard }) {
  async function request(url, init, opt) {
    const res = await guard.guardedFetch(url, init, opt)
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = { code: -999, message: `非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 160)}` }
    }
    if (json && typeof json.code === 'number') guard.noteCode(json.code, opt?.label)
    return json
  }

  const get = (url, room, opt) => request(url, { headers: headers(cred, room) }, opt)

  return {
    /** 登录态 + WBI 密钥 */
    async nav() {
      const j = await get(`${MAIN}/x/web-interface/nav`, null, { label: 'nav' })
      if (j.code !== 0) throw new Error(`拿不到登录态：${j.code} ${j.message ?? ''}（cookie 过期了？）`)
      const lv = j.data?.level_info?.current_level ?? j.data?.level ?? '?'
      return { uid: String(j.data.mid), uname: j.data.uname, images: j.data.wbi_img, level: lv }
    },

    /** 金瓜子/银瓜子余额。gold/1000 = 元 */
    async wallet() {
      const j = await get(`${LIVE}/xlive/revenue/v1/wallet/getStatus`, null, { label: 'wallet' })
      if (j.code !== 0) throw new Error(`拿不到余额：${j.code} ${j.message ?? ''}`)
      return j.data
    },

    /** 真实 room_id / 主播 uid / 标题 / 是否在播 */
    async roomInfo(roomId) {
      const j = await get(`${LIVE}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`, String(roomId), { label: 'room_info' })
      if (j.code !== 0) throw new Error(`拿不到房间信息：${j.code} ${j.message ?? ''}`)
      const d = j.data
      return { room: String(d.room_id), anchor: String(d.uid), title: d.title, live: d.live_status === 1 }
    },

    /** 礼物面板（含价格）。data.list 里可能是嵌套的分组，摊平 */
    async giftPanel(roomId) {
      const j = await get(`${LIVE}/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&room_id=${encodeURIComponent(roomId)}`, String(roomId), { label: 'gift_panel' })
      if (j.code !== 0) throw new Error(`拿不到礼物面板：${j.code} ${j.message ?? ''}`)
      const flat = []
      for (const g of j.data?.list ?? []) {
        if (Array.isArray(g.list)) flat.push(...g.list)
        else flat.push(g)
      }
      return flat.map((g) => ({
        id: Number(g.id ?? g.gift_id),
        name: String(g.name ?? ''),
        price: Number(g.price ?? 0),
        coin: String(g.coin_type ?? 'gold'),
      })).filter((g) => Number.isFinite(g.id) && g.id > 0)
    },

    /** 背包礼物（免费/活动直购）。list 为 null 表示空 */
    async bagList(roomId) {
      const j = await get(`${LIVE}/xlive/web-room/v1/gift/bag_list?t=${Date.now()}&room_id=${encodeURIComponent(roomId)}&mobi_app=web`, String(roomId), { label: 'bag_list' })
      if (j.code !== 0) throw new Error(`拿不到背包：${j.code} ${j.message ?? ''}`)
      return j.data?.list ?? []
    },

    /** 我的粉丝牌墙（分页拉全部） */
    async medals({ pages = 5, pageSize = 20 } = {}) {
      const out = []
      for (let page = 1; page <= pages; page++) {
        const j = await get(`${LIVE}/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=${pageSize}`, null, { label: 'medal_panel' })
        if (j.code !== 0) throw new Error(`拿不到粉丝牌：${j.code} ${j.message ?? ''}`)
        const list = j.data?.list ?? []
        for (const m of list) {
          const x = m.medal ?? m
          if (x && x.target_id) out.push(x)
        }
        const total = Number(j.data?.cnt ?? 0)
        if (list.length < pageSize || (total && out.length >= total)) break
      }
      return out
    },

    /**
     * 送礼。coins: gold | silver；bagId 非 0 走背包。
     *
     * 契约（2026-10 实测，详见 docs/live-gift.md）：
     *   - 参数全部放 query，body 必须为空
     *   - 必须带 WBI 签名
     *   - ruid 是主播 uid，biz_id 是真实 room_id
     */
    async sendGift({ room, anchor, giftId, giftNum = 1, coin = 'gold', bagId = 0, price = 0, uid, images }) {
      const kind = bagId ? 'sendBagMultiUser' : coin === 'gold' ? 'sendGoldMultiUser' : 'sendSilverMultiUser'
      const params = {
        uid,
        gift_id: String(giftId),
        ruid: String(anchor),
        send_ruid: '0',
        gift_num: String(giftNum),
        coin_type: coin,
        bag_id: String(bagId ?? 0),
        platform: 'pc',
        biz_code: 'Live',
        biz_id: String(room),
        storm_beat_id: '0',
        metadata: '',
        price: String(price ?? 0),
        receive_users: JSON.stringify([{ uid: Number(anchor) }]),
        all_flag: '0',
        live_statistics: JSON.stringify({
          pc_client: 'pcWeb', jumpfrom: '-99998', room_category: '0', source_event: 0, trackid: '-99998',
          official_channel: { program_room_id: '-99998', program_up_id: '-99998' },
        }),
        statistics: JSON.stringify({ platform: 5, pc_client: 'pcWeb', appId: 100 }),
        web_location: '444.8',
        csrf: cred.bili_jct,
      }
      const url = `${LIVE}/xlive/revenue/v2/gift/${kind}?${signWbi(params, images)}`
      const res = await request(url, { method: 'POST', headers: { ...headers(cred, room), 'content-length': '0' } }, { write: true, label: kind })
      return { kind, res }
    },
  }
}

/** 错误码人话 */
export const CODE_HINT = {
  0: '成功',
  '-400': '参数或签名没对上（最常见：忘了 WBI 签名、参数塞进 body、ruid 用错人）',
  200005: '房间号非法，或不能给自己送礼',
  200013: '余额不足（金瓜子不够）',
  200024: '房间数据异常：ruid / biz_id 对不上（必须用 Room/get_info 的真实 room_id 与主播 uid）',
  200026: '这个礼物不能在这个直播间用（礼物自带房间限制）',
  200042: '背包里没有这个礼物（bag_id 不存在或已过期）',
  1002002: '参数不对（比如 user_medal_info 的 uid 传成了 room_id）',
}
