// 微信同城配送接口：请求加密、签名（服务端 API 安全），回包解密，token 失效刷新，运力回调验签
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { createIntracity } = require('../server/lib/intracity')

const APPID = 'wxapp'
const AES_KEY = crypto.randomBytes(32)
const AES_SN = 'aes-sn-1'
const RSA_SN = 'rsa-sn-1'
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const URL_BASE = 'https://api.weixin.qq.com/cgi-bin/express/intracity/'

const aad = (url, ts) => Buffer.from(url + '|' + APPID + '|' + ts + '|' + AES_SN)

// 扮演微信：验签名、解请求，再把 reply(请求明文) 加密回去；reply 返回 { plain } 时回明文
function fakeWechat(reply) {
  const calls = []
  async function fetch(fullUrl, init) {
    const url = fullUrl.split('?')[0]
    const call = { url: fullUrl, headers: init.headers, raw: init.body }
    calls.push(call)
    if (url.endsWith('/apply')) {
      const out = reply(call)
      return respond(out.plain, {})
    }
    const h = init.headers
    const ts = h['Wechatmp-TimeStamp']
    call.signatureOk = crypto.verify('sha256', Buffer.from(url + '\n' + APPID + '\n' + ts + '\n' + init.body), {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }, Buffer.from(h['Wechatmp-Signature'], 'base64'))
    const req = JSON.parse(init.body)
    const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, Buffer.from(req.iv, 'base64'))
    decipher.setAAD(aad(url, ts))
    decipher.setAuthTag(Buffer.from(req.authtag, 'base64'))
    call.body = JSON.parse(Buffer.concat([decipher.update(Buffer.from(req.data, 'base64')), decipher.final()]).toString('utf8'))
    const out = reply(call)
    if (out.plain) return respond(out.plain, {})
    const rts = String(Number(ts) + 1)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv)
    cipher.setAAD(aad(url, rts))
    const data = Buffer.concat([cipher.update(JSON.stringify(out), 'utf8'), cipher.final()])
    const body = { iv: iv.toString('base64'), data: data.toString('base64'), authtag: cipher.getAuthTag().toString('base64') }
    if (out.tamper) body.data = Buffer.from('x' + data.toString('binary'), 'binary').toString('base64')
    return respond(body, { 'wechatmp-appid': APPID, 'wechatmp-timestamp': rts })
  }
  fetch.calls = calls
  return fetch
}

function respond(body, headers) {
  const h = new Map(Object.entries(headers))
  return { status: 200, headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) }, text: async () => JSON.stringify(body) }
}

function client(fetch, extra) {
  const tokens = []
  const api = createIntracity(Object.assign({
    appId: APPID,
    accessToken: async (force) => {
      tokens.push(force)
      return force ? 'T2' : 'T1'
    },
    aesKeySn: AES_SN,
    aesKey: AES_KEY.toString('base64'),
    rsaKeySn: RSA_SN,
    rsaPrivateKey: PEM,
    fetch
  }, extra || {}))
  api.tokens = tokens
  return api
}

test('密钥没配齐（或对称密钥不是 32 字节）时不算开通，调接口直接报错，不发请求', async () => {
  const fetch = fakeWechat(() => ({ errcode: 0 }))
  assert.equal(client(fetch).ready(), true)
  assert.equal(client(fetch, { aesKey: '' }).ready(), false)
  assert.equal(client(fetch, { aesKey: crypto.randomBytes(16).toString('base64') }).ready(), false)
  assert.equal(client(fetch, { rsaPrivateKey: '' }).ready(), false)
  await assert.rejects(client(fetch, { rsaKeySn: '' }).addOrder({}), (e) => e.errCode === -1)
  assert.equal(fetch.calls.length, 0)
})

test('请求加密并签名；微信回包解密后返回；请求里带上时间戳和 AppID 防重放', async () => {
  const fetch = fakeWechat((call) => ({ errcode: 0, errmsg: 'ok', wx_order_id: 'WX1', echo: call.body.store_order_id }))
  const api = client(fetch)
  const res = await api.addOrder({ wx_store_id: 'S1', store_order_id: 'A001', cargo: { cargo_name: '拿铁' } })
  assert.equal(res.wx_order_id, 'WX1')
  assert.equal(res.echo, 'A001')
  const c = fetch.calls[0]
  assert.equal(c.url, URL_BASE + 'addorder?access_token=T1')
  assert.equal(c.signatureOk, true, '签名能用公钥验过')
  assert.equal(c.headers['Wechatmp-Appid'], APPID)
  assert.equal(c.headers['Wechatmp-Serial'], RSA_SN)
  assert.equal(c.body._appid, APPID)
  assert.equal(String(c.body._timestamp), c.headers['Wechatmp-TimeStamp'])
  assert.ok(c.body._n)
  assert.equal(c.body.cargo.cargo_name, '拿铁')
  assert.ok(!c.raw.includes('A001'), '发出去的是密文')
})

test('token 失效时刷新一次再试；别的错误带错误码抛出；回包被改了解不开就报错', async () => {
  let n = 0
  const fetch = fakeWechat(() => {
    n++
    if (n === 1) return { plain: { errcode: 40001, errmsg: 'invalid credential' } }
    if (n === 2) return { errcode: 0, store_list: [] }
    if (n === 3) return { errcode: 9300506, errmsg: '运力不足' }
    return { errcode: 0, tamper: true }
  })
  const api = client(fetch)
  assert.deepEqual((await api.queryStore({ out_store_id: 'x' })).store_list, [])
  assert.deepEqual(api.tokens, [false, true])
  assert.match(fetch.calls[1].url, /access_token=T2$/)
  await assert.rejects(api.preAddOrder({}), (e) => e.errCode === 9300506 && e.errMsg === '运力不足')
  await assert.rejects(api.queryOrder({}), (e) => e.errCode === -1 && /解不开/.test(e.errMsg))
})

test('开通门店权限不加密；token 失效也刷新一次', async () => {
  let n = 0
  const fetch = fakeWechat(() => (++n === 1 ? { plain: { errcode: 42001 } } : { plain: { errcode: 0, errmsg: 'ok' } }))
  const api = client(fetch)
  assert.equal((await api.apply()).errmsg, 'ok')
  assert.equal(fetch.calls.length, 2)
  assert.equal(fetch.calls[1].raw, '{}')
})

test('运力回调：按字段排序加 Token 算 MD5，对了才认', () => {
  const api = client(fakeWechat(() => ({})))
  const body = { wx_order_id: 'WX1', order_status: 30000, store_order_id: 'A001', timestamp: 1700000000 }
  const sign = crypto.createHash('md5').update('order_status=30000&store_order_id=A001&timestamp=1700000000&wx_order_id=WX1&token=TK').digest('hex')
  assert.equal(api.verifyNotify(Object.assign({ sign }, body), 'TK'), true)
  assert.equal(api.verifyNotify(Object.assign({ sign: sign.toUpperCase() }, body), 'TK'), true)
  assert.equal(api.verifyNotify(Object.assign({ sign }, body, { order_status: 70000 }), 'TK'), false)
  assert.equal(api.verifyNotify(Object.assign({ sign }, body), 'other'), false)
  assert.equal(api.verifyNotify(Object.assign({ sign }, body), ''), false)
  assert.equal(api.verifyNotify(body, 'TK'), false)
})
