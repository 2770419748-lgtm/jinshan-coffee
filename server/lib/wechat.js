// 调微信服务器的接口：小程序登录换 openid、拿 access_token、生成小程序码。
// 需要小程序的 AppID 和 AppSecret（公众平台「开发管理 → 开发设置」里拿），填在服务器配置文件里。
const API = 'https://api.weixin.qq.com'
// access_token 失效时微信返回的错误码，遇到就刷新一次再试
const TOKEN_ERRORS = [40001, 40014, 42001]

function wxError(errcode, errmsg) {
  const e = new Error('errCode: ' + errcode + ' | errMsg: ' + (errmsg || ''))
  e.errCode = errcode
  e.errMsg = errmsg || ''
  return e
}

function createWechat({ appId, appSecret, fetch = globalThis.fetch }) {
  let token = null

  function ready() {
    return !!(appId && appSecret)
  }

  function check() {
    if (!ready()) throw new Error('服务器配置文件里还没填 appId 和 appSecret')
  }

  async function json(res) {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error('微信接口返回的不是 JSON：' + res.status + ' ' + text.slice(0, 200))
    }
  }

  // 稳定版 access_token：多处同时取也不会互相顶掉；提前 5 分钟换新的
  async function accessToken(force) {
    check()
    if (!force && token && token.expiresAt > Date.now()) return token.value
    const res = await fetch(API + '/cgi-bin/stable_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: !!force })
    })
    const data = await json(res)
    if (!data.access_token) throw wxError(data.errcode, data.errmsg)
    token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 7200) - 300) * 1000 }
    return token.value
  }

  // 小程序 wx.login 拿到的 code 换成 openid
  async function code2session(code) {
    check()
    const qs = new URLSearchParams({ appid: appId, secret: appSecret, js_code: String(code || ''), grant_type: 'authorization_code' })
    const data = await json(await fetch(API + '/sns/jscode2session?' + qs.toString()))
    if (!data.openid) throw wxError(data.errcode, data.errmsg)
    return { openid: data.openid, unionid: data.unionid || '' }
  }

  // 生成小程序码（不限数量的那种），参数写法和原来云开发的一样：scene、page、checkPath、envVersion、width
  async function getUnlimited(params, retried) {
    const body = {
      scene: params.scene,
      page: params.page,
      check_path: params.checkPath !== false,
      env_version: params.envVersion || 'release',
      width: params.width || 430
    }
    const res = await fetch(API + '/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(await accessToken(!!retried)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const type = res.headers.get('content-type') || ''
    if (/json|text/.test(type)) {
      const data = await json(res)
      if (!retried && TOKEN_ERRORS.indexOf(data.errcode) !== -1) return getUnlimited(params, true)
      throw wxError(data.errcode, data.errmsg)
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: type || 'image/jpeg' }
  }

  return { ready, accessToken, code2session, getUnlimited }
}

module.exports = { createWechat, wxError }
