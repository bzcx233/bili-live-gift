# 直播间送礼接口（2026-10 实测）

这份文档记录的是**逆向出来的事实**：B站 直播前端的送礼请求长什么样。
公开接口文档（如 bilibili-API-collect）**故意不含送礼**，所以网上流传的写法大多是错的。

如果你在别处看到 `POST /xlive/revenue/v1/gift/sendGift`：**那条路不存在**。
GET 它永远回 `{"code":-400,"message":"请求错误"}`，POST 它回纯文本 `Method Not Allowed`。

## 三条真路由

```
POST https://api.live.bilibili.com/xlive/revenue/v2/gift/sendGoldMultiUser?<query>
POST https://api.live.bilibili.com/xlive/revenue/v2/gift/sendSilverMultiUser?<query>
POST https://api.live.bilibili.com/xlive/revenue/v2/gift/sendBagMultiUser?<query>
```

规则，三条缺一不可：

1. **参数全部放在 query 上，body 必须为空**（`content-length: 0`）。挪进 body 会得到 `-400`。
2. **必须带 WBI 签名**：`wts` = 秒级时间戳，`w_rid` = md5(排序后的 query + mixinKey)。
   密钥来自 `GET https://api.bilibili.com/x/web-interface/nav` 的 `data.wbi_img`（详见 `src/wbi.mjs`）。
3. 头要带 cookie 和直播间 referer：
   `cookie: SESSDATA=…; bili_jct=…; buvid3=…`、`referer: https://live.bilibili.com/<房间号>`、`origin: https://live.bilibili.com`。

## 参数表

| 字段 | 值 |
| --- | --- |
| `uid` | 自己的 mid |
| `ruid` | **主播** 的 uid（`room/v1/Room/get_info` 的 `data.uid`） |
| `send_ruid` | `0` |
| `gift_id` | 礼物 id（`xlive/web-room/v1/giftPanel/giftConfig` 的 `id`） |
| `gift_num` | 数量（本工具固定 1） |
| `coin_type` | `gold` / `silver` |
| `bag_id` | 背包礼物才有，金瓜子礼物传 `0` |
| `platform` | `pc` |
| `biz_code` | `Live` |
| `biz_id` | **真实 room_id**（`Room/get_info` 的 `data.room_id`） |
| `storm_beat_id` | `0` |
| `metadata` | 空串 |
| `price` | 单价（金瓜子；背包礼物传 `0`） |
| `receive_users` | `[{"uid":主播uid}]` 的 JSON 字符串 |
| `all_flag` | `0` |
| `live_statistics` | `{"pc_client":"pcWeb","jumpfrom":"-99998","room_category":"0","source_event":0,"trackid":"-99998","official_channel":{"program_room_id":"-99998","program_up_id":"-99998"}}` |
| `statistics` | `{"platform":5,"pc_client":"pcWeb","appId":100}` |
| `web_location` | `444.8` |
| `csrf` | `bili_jct` |

`live_statistics` / `statistics` 是埋点字段，内容看着随意但**不能省**，省了会被当非法请求。

## 相关接口

| 用途 | 接口 |
| --- | --- |
| 余额 | `GET /xlive/revenue/v1/wallet/getStatus` → `{gold, silver, coin, ...}`，`gold/1000` = 元 |
| 房间信息 | `GET /room/v1/Room/get_info?room_id=R` → `data.room_id` / `data.uid` / `data.live_status` |
| 礼物面板 | `GET /xlive/web-room/v1/giftPanel/giftConfig?platform=pc&room_id=R` → `data.list[]`（`id/name/price/coin_type`） |
| 直播间礼物列表 | `GET /xlive/web-room/v1/giftPanel/roomGiftList?platform=pc&room_id=R` → `data.gift_data.room_gift_list.{gold_list,silver_list}` |
| 背包 | `GET /xlive/web-room/v1/gift/bag_list?t=<ms>&room_id=R&mobi_app=web` → `data.list`（`null` = 空） |
| 粉丝牌 | `GET /xlive/app-ucenter/v1/fansMedal/panel?page=1&page_size=20` → `data.list[].medal{target_id,target_name,medal_name,level,intimacy,next_intimacy,today_feed,day_limit}` |
| 佩戴中的牌 | `GET /xlive/app-ucenter/v1/fansMedal/user_medal_info?uid=<自己mid>` → `{cnt, curr_weared, ...}` |

`nav.wallet` 只有 `bcoin` / `coupon`（硬币、B币），**拿不到金瓜子**，余额只能走 `wallet/getStatus`。

## 错误码

| code | message | 含义 |
| --- | --- | --- |
| `0` | OK | 成功 |
| `-400` | 请求错误 | 参数或签名没对上：忘了签名 / 参数进了 body / 缺埋点字段 |
| `200002` | 功能已关闭 | 没带 cookie |
| `200005` | — | 房间号非法，或自己给自己送 |
| `200013` | 余额不足哦～ | 金瓜子不够（**可用来做零花费验证**） |
| `200024` | 系统错误,房间数据异常 | `ruid` / `biz_id` 对不上 |
| `200026` | 该礼物仅限直播间 N 使用 | 礼物自带房间限制 |
| `200042` | 包裹已过期 | `bag_id` 不存在或过期 |

## 怎么零花费验证一个送礼工具

1. 挑一个**余额买不起**的礼物（例如余额 3 元、礼物 ¥10 万），发起真实发送 →
   服务器回 `200013 余额不足`。路由、参数、签名、礼物、主播全被识别，一分钱没花。
2. 背包链路：给一个不存在的 `bag_id` → 回 `200042 包裹已过期`，证明签名 + POST 全链路通。

这两个探针比"我猜它是对的"靠谱得多，也是本项目 `send --dry` 之外唯一建议的验证方式。

## 死路清单（别再浪费请求）

- `GET/POST /xlive/revenue/v1/gift/sendGift` —— GET 永远 `-400`，POST `Method Not Allowed`
- `/xlive/revenue/v2/gift/sendGift`、`/xlive/app-room/v1/gift/sendGift` —— 404
- `/gift/v2/live/send`（更老的一版）—— `{"code":65530,"msg":"invalid request","data":"bad token"}`，被网关拦
- `/xlive/general-interface/v1/user/getBagList`、`/xlive/revenue/v1/gift/bagList` —— 404
- `/xlive/revenue/v1/wallet/getWallet`、`/xlive/general-interface/v1/user/getUserWallet` —— 404
- 粉丝牌：`web-room/v1/fansMedal/panel`、`web-ucenter/v1/fansMedal/panel`、
  `app-ucenter/v1/fansMedal/get_weared_medal`、`web-ucenter/v1/user/MedalWall`、
  `app-ucenter/v1/fansMedal/fans_medal_panel`、`app-ucenter/v1/fansMedal/getMedalList` —— 全 404

## 没做的事

- **上舰（开通/续费大航海）**：另一套接口 + 另一套授权逻辑，本工具不涉及。
- **免费礼物"领取"**：不存在这个动作，见 README。
- **自动/批量送礼**：不做。
