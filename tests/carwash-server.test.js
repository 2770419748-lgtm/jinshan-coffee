// 两个小程序走同一个服务器：UnionID 认人（咖啡、洗车里是同一个人、同一个会员号），洗车用自己的 AppID 和商户号，
// 洗车的支付通知只认洗车商户号的密钥；美团抖音核销还没开通
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { createApp } = require('../server/app')
const { Database } = require('../server/lib/db')
const { createWxpay } = require('../server/lib/wxpay')
const { fakeFetch, encryptNotify, API_V3_KEY } = require('./helpers/wx')

const CARWASH_KEY = 'ZYXWVUTSRQPONMLKJIHGFEDCBA987654'

// code 写成「openid:unionid」，没有冒号就是没绑开放平台（没有 unionid）
const wechatOf = (prefix) => ({
  ready: () => true,
  code2session: async (code) => {
    const [who, unionid] = code.split(':')
    return { openid: prefix + who, unionid: unionid || '' }
  },
  getUnlimited: async () => ({ buffer: Buffer.from('png'), contentType: 'image/png' })
})
const key = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
const coffeeFetch = fakeFetch([])
const carwashFetch = fakeFetch([])
const coffeePay = createWxpay({ appId: 'wxcoffee', mchId: '1900000109', serialNo: 'S1', privateKey: key(), apiV3Key: API_V3_KEY, notifyBase: 'https://shop.example.com', fetch: coffeeFetch })
const carwashPay = createWxpay({ appId: 'wxcarwash', mchId: '1900000209', serialNo: 'S2', privateKey: key(), apiV3Key: CARWASH_KEY, notifyBase: 'https://shop.example.com', fetch: carwashFetch })
const db = new Database(':memory:')
const storage = { root: '/nonexistent', resolve: () => null }
const { server } = createApp({
  config: { adminDir: '/nonexistent', ownerCode: '' },
  db,
  wechat: wechatOf('CF_'),
  pay: coffeePay,
  storage,
  carwash: { wechat: wechatOf('CW_'), pay: carwashPay }
})

let base
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = 'http://127.0.0.1:' + server.address().port
  resolve()
})))
test.after(() => server.close())

async function post(p, body, headers) {
  const res = await fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

async function login(code, app) {
  const res = await post('/api/login', app ? { code, app } : { code })
  assert.equal(res.body.ok, true, JSON.stringify(res.body))
  return res.body.data.token
}

function call(token, mod, action, data) {
  return post('/api/' + mod, Object.assign({ action }, data || {}), { 'x-session': token }).then((r) => r.body)
}

async function ok(p) {
  const res = await p
  assert.equal(res.ok, true, JSON.stringify(res))
  return res.data
}

const t = {}

test('同一个微信号（同一个 unionid）在两个小程序里是同一个人、同一个会员号', async () => {
  t.owner = await login('BOSS:U0')
  await ok(call(t.owner, 'common', 'bindOwner', { name: '坤总' }))
  t.aliceCoffee = await login('alice:U1')
  t.aliceCarwash = await login('alice:U1', 'carwash')
  const s = (await db.collection('mp_sessions').where({ appOpenid: 'CW_alice' }).limit(1).get()).data[0]
  assert.equal(s.openid, 'CF_alice', '用户 id 沿用先登录的咖啡小程序的 openid')
  assert.equal(s.app, 'carwash')
  assert.equal(s.unionid, 'U1')
  const cf = await ok(call(t.aliceCoffee, 'member', 'getMember'))
  const cw = await ok(call(t.aliceCarwash, 'carwash', 'getMember'))
  assert.equal(cw.member.memberNo, cf.member.memberNo)
  const u = (await db.collection('wx_users').where({ _id: 'U1' }).limit(1).get()).data[0]
  assert.deepEqual(u.openids, { coffee: 'CF_alice', carwash: 'CW_alice' })
  // 店主在洗车小程序里也是店主
  t.ownerCarwash = await login('BOSS:U0', 'carwash')
  assert.equal((await ok(call(t.ownerCarwash, 'common', 'login'))).staff.role, 'owner')
})

test('先用洗车小程序的人，之后到咖啡也认得；没绑开放平台（没有 unionid）时两边各算各的', async () => {
  t.bobCarwash = await login('bob:U2', 'carwash')
  t.bobCoffee = await login('bob:U2')
  const cw = await ok(call(t.bobCarwash, 'carwash', 'getMember'))
  const cf = await ok(call(t.bobCoffee, 'member', 'getMember'))
  assert.equal(cf.member.memberNo, cw.member.memberNo)
  t.carolCarwash = await login('carol', 'carwash')
  t.carolCoffee = await login('carol')
  const a = await ok(call(t.carolCarwash, 'carwash', 'getMember'))
  const b = await ok(call(t.carolCoffee, 'member', 'getMember'))
  assert.notEqual(a.member.memberNo, b.member.memberNo)
  assert.equal((await post('/api/login', { code: 'x', app: 'bogus' })).status, 400)
})

test('洗车充值走洗车的 AppID 和商户号；付款人是洗车小程序里的 openid', async () => {
  await ok(call(t.ownerCarwash, 'carwash', 'saveSettings', { settings: { payEnabled: true } }))
  await ok(call(t.ownerCarwash, 'carwash', 'saveMemberSettings', { enabled: true }))
  const plan = await ok(call(t.ownerCarwash, 'carwash', 'savePlan', { plan: { price: 30000, bonus: 5000 } }))
  carwashFetch.queue.push({ body: { prepay_id: 'wxCW1' } })
  const r = await ok(call(t.aliceCarwash, 'carwash', 'createRecharge', { planId: plan.id }))
  assert.equal(r.payment.package, 'prepay_id=wxCW1')
  const sent = JSON.parse(carwashFetch.calls[0].init.body)
  assert.equal(sent.appid, 'wxcarwash')
  assert.equal(sent.mchid, '1900000209')
  assert.equal(sent.payer.openid, 'CW_alice')
  assert.equal(sent.notify_url, 'https://shop.example.com/pay/notify/carwash')
  assert.equal(coffeeFetch.calls.length, 0)
  const rechargeNo = sent.out_trade_no
  // 用咖啡商户号的密钥加密的通知，洗车这边不认
  const forged = await post('/pay/notify/carwash', encryptNotify({ out_trade_no: rechargeNo, trade_state: 'SUCCESS' }, API_V3_KEY))
  assert.equal(forged.status, 400)
  carwashFetch.queue.push({ body: { trade_state: 'SUCCESS', transaction_id: 'tx1', amount: { total: 30000 } } })
  const res = await post('/pay/notify/carwash', encryptNotify({ out_trade_no: rechargeNo, trade_state: 'SUCCESS' }, CARWASH_KEY))
  assert.equal(res.status, 204)
  const me = await ok(call(t.aliceCarwash, 'carwash', 'getMember'))
  assert.equal(me.member.balance, 35000)
  // 咖啡的余额不动
  assert.equal((await ok(call(t.aliceCoffee, 'member', 'getMember'))).member.balance, 0)
  // 在咖啡小程序里发起洗车充值不行（付款人 openid 对不上洗车的 AppID）
  assert.equal((await call(t.aliceCoffee, 'carwash', 'createRecharge', { planId: plan.id })).code, 'WRONG_APP')
})

test('美团抖音核销还没开通：店员调用回「还没开通」，顾客没权限', async () => {
  assert.equal((await ok(call(t.ownerCarwash, 'carwash', 'redeemStatus'))).enabled, false)
  assert.equal((await call(t.ownerCarwash, 'carwash', 'redeemPrepare', { platform: 1, code: '123' })).code, 'REDEEM_DISABLED')
  assert.equal((await call(t.aliceCarwash, 'carwash', 'redeemPrepare', { platform: 1, code: '123' })).code, 'FORBIDDEN')
})
