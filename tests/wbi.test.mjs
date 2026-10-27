// 离线单测：不需要 cookie、不碰网络。只管签名和护栏这类"错了会花钱"的逻辑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { signWbi, wbiKey } from '../src/wbi.mjs'

// 假的 wbi_img：64 位文件名，够密钥算法跑起来
const IMAGES = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
}

test('wbiKey 是 32 位，且由两个文件名决定', () => {
  const key = wbiKey(IMAGES)
  assert.equal(key.length, 32)
  assert.match(key, /^[0-9a-f]{32}$/)
  // 换 sub_url 必须换密钥
  const other = wbiKey({ ...IMAGES, sub_url: 'https://i0.hdslb.com/bfs/wbi/00000000000000000000000000000000.png' })
  assert.notEqual(key, other)
})

test('wbiKey 在 wbi_img 不全时抛错（避免拿空密钥去签名）', () => {
  assert.throws(() => wbiKey({ img_url: IMAGES.img_url }), /WBI 密钥/)
  assert.throws(() => wbiKey({}), /WBI 密钥/)
})

test('signWbi 输出：键排序 + 必带 wts 与 w_rid', () => {
  const q = signWbi({ b: '2', a: '1', csrf: 'deadbeef' }, IMAGES, 1700000000000)
  assert.match(q, /^a=1&b=2&csrf=deadbeef&wts=1700000000&w_rid=[0-9a-f]{32}$/)
})

test('signWbi 是确定性的（同一时刻同一参数同一结果）', () => {
  const p = { uid: '1', gift_id: '34016', gift_num: '1' }
  assert.equal(signWbi(p, IMAGES, 1700000000000), signWbi(p, IMAGES, 1700000000000))
  assert.notEqual(signWbi(p, IMAGES, 1700000000000), signWbi(p, IMAGES, 1700000001000))
})

test('signWbi 会丢 null/undefined，并强制重算 w_rid', () => {
  const q = signWbi({ a: '1', b: null, c: undefined, w_rid: 'stale' }, IMAGES, 1700000000000)
  assert.ok(!q.includes('b='))
  assert.ok(!q.includes('c='))
  assert.equal(q.match(/w_rid=/g).length, 1)
})

test('signWbi 对特殊字符做 encode 并剥掉 !\'()*', () => {
  const q = signWbi({ metadata: "a!'()*b c" }, IMAGES, 1700000000000)
  assert.ok(q.includes('metadata=ab%20c'), q)
})
