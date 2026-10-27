# bili-live-gift

命令行给 B站 直播间送礼物。**一次一笔、单价有上限、发前看余额发后对账**，不做批量刷。

写它的起因很简单：网上流传的送礼接口 `POST /xlive/revenue/v1/gift/sendGift` **根本不存在**
（GET 永远回 `-400`，POST 回纯文本 `Method Not Allowed`），照着它写的工具从来没真发出去过。
真接口在直播间前端 bundle 里，参数、签名、字段含义都记在 [docs/live-gift.md](docs/live-gift.md)。

```
$ bili-live-gift whoami
我 小鱼（uid=1234567，等级 2）
金瓜子 3140（¥3.14） · 银瓜子 1350 · 硬币 49
今天已送 ¥0.00 / ¥20.00

$ bili-live-gift send --room 12345678 --gift 34016 --dry
=== 送礼预检 ===
  房间 12345678（某某的直播间）主播 uid=987654321  未开播
  我 小鱼 uid=1234567  余额 3140 金瓜子（¥3.14）
  礼物「小花花」 id=34016 ×1  单价 100 金瓜子 = ¥0.10
  今天已送 ¥0.00 / ¥20.00

[dry] 预检通过，未发送。把 --dry 换成 --go 才会真发（一次一笔）。
```

> 上面的 uid / 余额是占位示例，不是任何真实账号。

## 安装

需要 Node.js ≥ 18（自带 `fetch` 和 `crypto`，没有第三方依赖）。

```bash
git clone https://github.com/<you>/bili-live-gift.git
cd bili-live-gift
node bin/bili-gift.mjs help          # 直接跑，不用 npm install
# 或装成全局命令
npm link
```

## 登录态

三种给法，任选一种：

```bash
# ① 环境变量
export BILI_SESSDATA='...'   BILI_JCT='...'   BILI_BUVID3='...'

# ② 指定文件
BILI_COOKIE_FILE=/path/to/cookies.json node bin/bili-gift.mjs wallet

# ③ 默认路径（推荐）
mkdir -p ~/.config/bili-live-gift
cat > ~/.config/bili-live-gift/cookies.json <<'EOF'
{"sessdata":"...","bili_jct":"...","buvid3":"..."}
EOF
chmod 600 ~/.config/bili-live-gift/cookies.json
```

`SESSDATA` 和 `bili_jct` 从浏览器 F12 → Application → Cookies → `bilibili.com` 里复制
（`bili_jct` 就是那个 32 位 hex）。**这俩等于账号密码**：别提交、别截图、别贴群。

## 命令

| 命令 | 作用 |
|---|---|
| `whoami` | 我是谁 + 余额 + 今天花了多少 |
| `wallet` | 余额 + 流水 + 本地闸门状态 |
| `list --room R [--max 1]` | 礼物面板（按价格排序；`--max` 只留 ≤¥N 的金瓜子礼物） |
| `bag --room R` | 背包礼物（免费/活动直购） |
| `claim --room R --gift ID --bag BID [--go]` | 把背包礼物送出去（不动金瓜子） |
| `send --room R --gift ID [--dry\|--go]` | 送礼，一次一个 |
| `medal [--room R]` | 我的粉丝牌 / 亲密度 / 今日已喂 |
| `log [--n 20]` / `stats` / `budget` | 流水 / 汇总 / 今天还能花多少 |
| `config` | 生成默认配置文件 |

## 护栏：这些是硬编码的，不是建议

| 护栏 | 实现 |
|---|---|
| 一次只能 1 个礼物 | `--num` 不等于 1 直接退出 |
| 单价上限 | 默认 ¥1.00（`maxUnitPriceGold: 1000`）。**只能在配置里改，没有命令行开关** |
| 不发就不发 | 没有 `--go` 只打预检，绝不请求发送接口 |
| 双余额闸 | 金瓜子余额不够 → 拒；今天已花 + 这一笔超过 `dailyLimitYen`（默认 ¥20）→ 拒 |
| 发后对账 | 发前读 `wallet/getStatus`、发后回读，**差额必须正好等于单价**，否则 exit 5 让你看流水 |
| 本地写额度 | 每小时 12 条、每天 60 条、两条写之间隔 120 秒；撞 412 熔断 2 小时 |

改配置：`~/.config/bili-live-gift/config.json`（`bili-live-gift config` 会生成默认值）。
流水在 `~/.local/share/bili-live-gift/ledger.jsonl`，一行一笔，可以自己 grep。

## 怎么在不花钱的前提下确认它真的能发

这是本项目最推荐的一步，用它检查任何送礼工具都行：

1. **拿买不起的礼物打一发**。挑一个单价远大于余额的礼物（比如 ¥10 万的宝盒，余额只有 3 块），
   服务器会回 `{"code":200013,"message":"余额不足哦～"}` —— 说明路由、参数、WBI 签名、礼物 id、
   主播 uid 全部被识别，而**一分钱没花**。
2. **背包链路**。给一个不存在的 `bag_id`，服务器回 `200042 包裹已过期` —— 说明签名和 POST 全链路通。

错误码对照：

| code | 意思 | 通常是哪错了 |
|---|---|---|
| `-400` | 请求错误 | 没签名 / 参数塞进了 body / `ruid` 用错人 |
| `200013` | 余额不足 | 金瓜子不够（也可以用这个做零花费验证） |
| `200024` | 房间数据异常 | `ruid` 必须是主播 uid、`biz_id` 必须是真实 room_id |
| `200026` | 礼物限特定直播间 | 换个礼物 |
| `200042` | 包裹已过期 | `bag_id` 不存在 |

## 它不做什么

- **不自动上舰、不定时循环送礼**。这两件事的本质是"程序自己决定扣钱"。真要定时，就定时提醒人、人来点。
- **不做"免费礼物一键领取"**。B站 没有"点击领取"这种接口：免费礼物是**背包礼物**，
  用 `claim` 送出去才算用掉（不扣金瓜子）。背包空的时候无做可做。
- **不做多房间铺量 / 多账号**。没有这个开关，也不会加。

## 文档

- [docs/live-gift.md](docs/live-gift.md) —— 接口契约：三条 v2 路由、完整参数表、错误码、死路清单
- [NOTICE.md](NOTICE.md) —— 第三方与免责
- [examples/config.example.json](examples/config.example.json) —— 配置示例

## 许可

MIT。参考了 `dsh-bili-whale`（MIT，© 2026 ALTERSSSS）与社区的 B站 接口整理，详见 [NOTICE.md](NOTICE.md)。
