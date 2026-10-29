// 微信同城配送（小程序「同城配送」能力，接口在 /cgi-bin/express/intracity/ 下）：一个接口叫顺丰同城、达达等运力，
// 运费在小程序后台给门店预充值，不用和每家配送公司分别签约。
// 除了「开通门店权限」，其余接口都要走微信的「服务端 API 安全」：请求体用对称密钥 AES-256-GCM 加密，
// 再用非对称私钥 RSA-PSS(SHA-256) 签名；微信的回包同样是加密的，用同一把对称密钥解开。
// 密钥在公众平台「开发管理 → 开发设置 → API 安全」里生成，填在服务器配置文件里（见 README「外送配送」），不进代码仓库。
const crypto = require('crypto')

const API = 'https://api.weixin.qq.com'
const PREFIX = '/cgi-bin/express/intracity/'
// access_token 失效时微信返回的错误码，遇到就刷新一次再试
const TOKEN_ERRORS = [40001, 40014, 42001]

function intracityError(errcode, errmsg) {
  const e = new Error('intracity errCode: ' + errcode + ' | errMsg: ' + (errmsg || ''))
  e.errCode = errcode
  e.errMsg = errmsg || ''
  return e
}

// options: { appId, accessToken(force) → token, aesKeySn, aesKey（base64，32 字节）, rsaKeySn, rsaPrivateKey（PEM）, fetch }
function createIntracity(options) {
  const o = Object.assign({ fetch: globalThis.fetch }, options || {})
  let aesKey = null
  try {
    aesKey = o.aesKey ? Buffer.from(String(o.aesKey), 'base64') : null
  } catch (e) {
    aesKey = null
  }

  function ready() {
    return !!(o.appId && o.accessToken && o.aesKeySn && aesKey && aesKey.length === 32 && o.rsaKeySn && o.rsaPrivateKey)
  }

  function check() {
    if (!ready()) throw intracityError(-1, '服务器配置文件里还没填同城配送的 API 安全密钥')
  }

  function encrypt(urlPath, ts, body) {
    const plain = JSON.stringify(Object.assign({}, body, {
      _n: crypto.randomBytes(16).toString('base64').replace(/=+$/, ''),
      _appid: o.appId,
      _timestamp: ts
    }))
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv)
    cipher.setAAD(Buffer.from(urlPath + '|' + o.appId + '|' + ts + '|' + o.aesKeySn))
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), data: data.toString('base64'), authtag: cipher.getAuthTag().toString('base64') }
  }

  function sign(urlPath, ts, text) {
    return crypto.sign('sha256', Buffer.from(urlPath + '\n' + o.appId + '\n' + ts + '\n' + text), {
      key: o.rsaPrivateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }).toString('base64')
  }

  function decrypt(urlPath, ts, body) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(String(body.iv || ''), 'base64'))
    decipher.setAAD(Buffer.from(urlPath + '|' + o.appId + '|' + ts + '|' + o.aesKeySn))
    decipher.setAuthTag(Buffer.from(String(body.authtag || ''), 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(String(body.data || ''), 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(text)
  }

  async function readJson(res) {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw intracityError(-1, '微信返回的不是 JSON：' + res.status + ' ' + text.slice(0, 200))
    }
  }

  // 加密调用一个接口，返回解密后的结果；errcode 不是 0 时抛错
  async function call(name, body, retried) {
    check()
    const url = API + PREFIX + name
    const ts = Math.floor(Date.now() / 1000)
    const text = JSON.stringify(encrypt(url, ts, body || {}))
    const res = await o.fetch(url + '?access_token=' + encodeURIComponent(await o.accessToken(!!retried)), {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=utf-8',
        accept: 'application/json',
        'Wechatmp-Appid': o.appId,
        'Wechatmp-TimeStamp': String(ts),
        'Wechatmp-Serial': o.rsaKeySn,
        'Wechatmp-Signature': sign(url, ts, text)
      },
      body: text
    })
    const raw = await readJson(res)
    let data = raw
    // 正常的回包是加密的；签名、token 不对时微信直接回明文的 errcode
    if (raw && raw.iv && raw.data && raw.authtag) {
      if (res.headers.get('wechatmp-appid') && res.headers.get('wechatmp-appid') !== o.appId) throw intracityError(-1, '回包的 AppID 对不上')
      try {
        data = decrypt(url, res.headers.get('wechatmp-timestamp') || '', raw)
      } catch (e) {
        throw intracityError(-1, '回包解不开，检查对称密钥和编号是不是同一组：' + e.message)
      }
    }
    if (data && data.errcode) {
      if (TOKEN_ERRORS.indexOf(data.errcode) !== -1 && !retried) return call(name, body, true)
      throw intracityError(data.errcode, data.errmsg)
    }
    return data || {}
  }

  // 开通门店权限：不用加密，第一次用同城配送前调一次（已经开通过再调也没关系）
  async function apply(retried) {
    const res = await o.fetch(API + PREFIX + 'apply?access_token=' + encodeURIComponent(await o.accessToken(!!retried)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    const data = await readJson(res)
    if (data.errcode && TOKEN_ERRORS.indexOf(data.errcode) !== -1 && !retried) return apply(true)
    if (data.errcode) throw intracityError(data.errcode, data.errmsg)
    return data
  }

  // 运力回调的签名：除 sign 外的字段按 key=value 排好用 & 连起来，再接 &token=消息推送的 Token，MD5 小写
  function verifyNotify(body, token) {
    if (!body || typeof body !== 'object' || !token || typeof body.sign !== 'string') return false
    const pairs = Object.keys(body).filter((k) => k !== 'sign').map((k) => k + '=' + body[k]).sort()
    const expect = crypto.createHash('md5').update(pairs.join('&') + '&token=' + token).digest('hex')
    return expect.length === body.sign.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(body.sign.toLowerCase()))
  }

  return {
    ready,
    apply,
    call,
    verifyNotify,
    createStore: (body) => call('createstore', body),
    updateStore: (body) => call('updatestore', body),
    queryStore: (body) => call('querystore', body),
    balance: (body) => call('balancequery', body),
    charge: (body) => call('storecharge', body),
    preAddOrder: (body) => call('preaddorder', body),
    addOrder: (body) => call('addorder', body),
    queryOrder: (body) => call('queryorder', body),
    cancelOrder: (body) => call('cancelorder', body),
    mockNotify: (body) => call('mocknotify', body)
  }
}

module.exports = { createIntracity, intracityError }
