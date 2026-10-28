// 服务器整体跑一遍：真的 HTTP、真的 SQLite、真的图片存储和微信支付 v3 代码，只有微信服务器是假的
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createApp } = require('../server/app')
const { Database } = require('../server/lib/db')
const { createStorage } = require('../server/lib/storage')
const { createWxpay } = require('../server/lib/wxpay')
const { fakeFetch, encryptNotify, API_V3_KEY } = require('./helpers/wx')
const crypto = require('crypto')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jinshan-server-'))
const adminDir = path.join(tmp, 'admin')
fs.mkdirSync(path.join(adminDir, 'assets'), { recursive: true })
fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html><title>进山管理后台</title>')
fs.writeFileSync(path.join(adminDir, 'assets', 'app.js'), 'console.log(1)')
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret')

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(50)])

const wechat = {
  ready: () => true,
  code2session: async (code) => {
    if (code === 'bad') throw Object.assign(new Error('invalid code'), { errCode: 40029 })
    return { openid: code }
  },
  getUnlimited: async () => ({ buffer: PNG, contentType: 'image/png' })
}
const payFetch = fakeFetch([])
const merchantKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
const pay = createWxpay({ appId: 'wxapp', mchId: '1900000109', serialNo: 'S1', privateKey: merchantKey, apiV3Key: API_V3_KEY, notifyBase: 'https://shop.example.com', fetch: payFetch })
const db = new Database(':memory:')
const storage = createStorage({ dir: path.join(tmp, 'uploads') })
const { server } = createApp({ config: { adminDir, ownerCode: '' }, db, wechat, pay, storage })

let base
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = 'http://127.0.0.1:' + server.address().port
  resolve()
})))
test.after(() => {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function post(p, body, headers) {
  const res = await fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

async function login(code) {
  const res = await post('/api/login', { code })
  assert.equal(res.body.ok, true, JSON.stringify(res.body))
  return res.body.data.token
}

function call(token, mod, action, data) {
  return post('/api/' + mod, Object.assign({ action }, data || {}), token ? { 'x-session': token } : {}).then((r) => r.body)
}

function upload(headers, buf, filename, folder) {
  const form = new FormData()
  form.append('file', new Blob([buf]), filename || 'a.jpg')
  return fetch(base + '/api/upload?folder=' + (folder || 'products'), { method: 'POST', headers, body: form }).then((r) => r.json())
}

const tokens = {}

test('首页跳到网页后台；网页后台的文件能打开，目录外面的打不开', async () => {
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, env: 'prod' })
  const home = await fetch(base + '/', { redirect: 'manual' })
  assert.equal(home.status, 302)
  assert.equal(home.headers.get('location'), '/admin/')
  const page = await fetch(base + '/admin/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(await page.text(), /进山管理后台/)
  const asset = await fetch(base + '/admin/assets/app.js')
  assert.match(asset.headers.get('cache-control'), /immutable/)
  assert.equal((await fetch(base + '/admin/%2e%2e/secret.txt')).status, 404)
  assert.equal((await fetch(base + '/uploads/%2e%2e/secret.txt')).status, 404)
  assert.equal((await fetch(base + '/nothing')).status, 404)
})

test('小程序登录：code 换登录状态，之后用微信身份调接口', async () => {
  tokens.owner = await login('OWNER')
  tokens.alice = await login('ALICE')
  assert.match(tokens.owner, /^[0-9a-f]{64}$/)
  const me = await call(tokens.alice, 'common', 'login')
  assert.deepEqual(me.data, { staff: null, hasOwner: false, ownerCodeRequired: false })
  assert.equal((await call(tokens.owner, 'common', 'bindOwner', { name: '坤总' })).ok, true)
  assert.equal((await call(tokens.owner, 'common', 'login')).data.staff.role, 'owner')
  // 数据库里只存登录状态的哈希
  assert.equal((await db.collection('mp_sessions').where({ _id: tokens.owner }).count()).total, 0)
  assert.equal((await db.collection('mp_sessions').where({ openid: 'OWNER' }).count()).total, 1)
})

test('登录状态不对、过期、请求格式不对都有明确的回应', async () => {
  assert.equal((await call('f'.repeat(64), 'common', 'login')).code, 'NEED_WX_LOGIN')
  assert.equal((await call('nonsense', 'common', 'login')).code, 'NEED_WX_LOGIN')
  const t = await login('BOB')
  await db.collection('mp_sessions').where({ openid: 'BOB' }).update({ data: { expiresAt: Date.now() - 1 } })
  assert.equal((await call(t, 'common', 'login')).code, 'NEED_WX_LOGIN')
  assert.equal((await post('/api/login', { code: 'bad' })).body.code, 'WX_LOGIN_FAILED')
  assert.equal((await post('/api/login', {})).status, 400)
  assert.equal((await post('/api/common', { noAction: 1 })).status, 400)
  assert.equal((await post('/api/common', '{oops')).status, 400)
  assert.equal((await post('/api/nope', { action: 'x' })).status, 404)
  // 没带登录状态时相当于没登录，只能调公开的操作
  assert.equal((await call('', 'coffee', 'listOrders')).code, 'NEED_LOGIN')
})

test('上传图片：只有员工能传，只收图片，传完能打开', async () => {
  assert.equal((await upload({ 'x-session': tokens.alice }, JPEG)).code, 'FORBIDDEN')
  assert.equal((await upload({}, JPEG)).code, 'FORBIDDEN')
  assert.equal((await upload({ 'x-session': tokens.owner }, Buffer.from('<script>alert(1)</script>'), 'x.html')).code, 'BAD_IMAGE')
  const res = await upload({ 'x-session': tokens.owner }, JPEG, 'cake.jpg', 'products')
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.data.fileID, /^\/uploads\/products\/\d{6}\/[0-9a-z]+\.jpg$/)
  const img = await fetch(base + res.data.fileID)
  assert.equal(img.status, 200)
  assert.equal(img.headers.get('content-type'), 'image/jpeg')
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG)
  // 文件夹名乱填的归到 misc
  assert.match((await upload({ 'x-session': tokens.owner }, PNG, 'a.png', '../etc')).data.fileID, /^\/uploads\/misc\//)
  // 网页后台用 webToken 上传
  await call(tokens.owner, 'common', 'setWebAccount', { username: 'boss', password: 'jinshan2026' })
  const web = await call('', 'common', 'webLogin', { username: 'boss', password: 'jinshan2026' })
  const viaWeb = await upload({ 'x-web-token': web.data.token }, PNG, 'b.png', 'covers')
  assert.match(viaWeb.data.fileID, /^\/uploads\/covers\/.*\.png$/)
  assert.equal((await upload({ 'x-web-token': 'x'.repeat(64) }, PNG)).code, 'FORBIDDEN')
  // 删除商品时图片文件一起删掉
  await call(tokens.owner, 'coffee', 'seedDemo')
  const menu = (await call(tokens.alice, 'coffee', 'getMenu')).data
  const cake = menu.products.find((p) => p.name === '芝士蛋糕')
  const full = (await call(tokens.owner, 'coffee', 'getProduct', { id: cake._id })).data
  await call(tokens.owner, 'coffee', 'saveProduct', { product: Object.assign({}, full, { image: res.data.fileID }) })
  assert.equal((await call(tokens.owner, 'coffee', 'deleteProduct', { id: cake._id })).ok, true)
  assert.equal((await fetch(base + res.data.fileID)).status, 404)
})

test('桌码：生成的小程序码存在服务器上', async () => {
  const { data } = await call(tokens.owner, 'coffee', 'saveTable', { tableNo: '5' })
  const code = await call(tokens.owner, 'coffee', 'genTableCode', { id: data.id, envVersion: 'trial' })
  assert.match(code.data.fileID, /^\/uploads\/table-codes\/trial\/table-5-\d+\.png$/)
  const img = await fetch(base + code.data.fileID)
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG)
})

test('微信支付：下单拿到支付参数，微信通知到了查单确认后标成已付', async () => {
  assert.equal((await call(tokens.owner, 'common', 'saveShopSettings', { payEnabled: true, allowCounter: true })).ok, true)
  const menu = (await call(tokens.alice, 'coffee', 'getMenu')).data
  const pour = menu.products.find((p) => p.name === '手冲')
  const order = (await call(tokens.alice, 'coffee', 'createOrder', { mode: 'takeaway', items: [{ productId: pour._id, qty: 1 }] })).data
  const detail = (await call(tokens.alice, 'coffee', 'getOrder', { id: order.id })).data

  // 微信支付服务器的两次回复：下单、查单
  payFetch.queue.push({ body: { prepay_id: 'wx123' } }, { body: { trade_state: 'SUCCESS', transaction_id: 'tx9', amount: { total: detail.payFee } } })

  const paid = await call(tokens.alice, 'coffee', 'payOrder', { id: order.id })
  assert.equal(paid.ok, true, JSON.stringify(paid))
  assert.equal(paid.data.payment.package, 'prepay_id=wx123')
  const sent = JSON.parse(lastCall().init.body)
  assert.equal(sent.payer.openid, 'ALICE')
  assert.equal(sent.notify_url, 'https://shop.example.com/pay/notify/coffee')

  // 伪造的通知（密钥不对）不认
  const forged = await post('/pay/notify/coffee', encryptNotify({ out_trade_no: detail.orderNo, trade_state: 'SUCCESS' }, 'z'.repeat(32)))
  assert.equal(forged.status, 400)
  assert.equal((await call(tokens.alice, 'coffee', 'getOrder', { id: order.id })).data.payStatus, 'unpaid')

  const res = await post('/pay/notify/coffee', encryptNotify({ out_trade_no: detail.orderNo, trade_state: 'SUCCESS', amount: { total: detail.payFee } }))
  assert.equal(res.status, 204)
  assert.match(lastCall().url, new RegExp('/v3/pay/transactions/out-trade-no/' + detail.orderNo))
  const after = (await call(tokens.alice, 'coffee', 'getOrder', { id: order.id })).data
  assert.equal(after.payStatus, 'paid')
  assert.equal(after.transactionId, 'tx9')
  assert.equal(payFetch.queue.length, 0)
})

function lastCall() {
  return payFetch.calls[payFetch.calls.length - 1]
}
