// 调自己的服务器：POST 服务器地址/api/模块名，body 是 { action, ...参数 }，返回 { ok, data, msg, code }
// 第一次调用前先 wx.login 换登录状态（存在本地，30 天有效），过期了自动重新登录一次再调。
// 服务器存的图片地址是 /uploads/ 开头的，这里收到时补上服务器地址，发出去时再去掉，换域名也不受影响。
const config = require('../config')

const TOKEN_KEY = 'jinshan_session'
const UPLOADS = '/uploads/'

let token = wx.getStorageSync(TOKEN_KEY) || ''
let loggingIn = null

function base() {
  return String(config.apiBase || '').replace(/\/+$/, '')
}

class ApiError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

function fixUrls(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => fixUrls(v, fn))
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach((k) => { out[k] = fixUrls(value[k], fn) })
    return out
  }
  return value
}

const toFull = (s) => (s.indexOf(UPLOADS) === 0 ? base() + s : s)
const toPath = (s) => (base() && s.indexOf(base() + UPLOADS) === 0 ? s.slice(base().length) : s)

function request(path, data, header) {
  if (!base()) return Promise.reject(new ApiError('还没填服务器地址：打开 miniprogram/config.js 填 apiBase', 'NO_SERVER'))
  return new Promise((resolve, reject) => {
    wx.request({
      url: base() + path,
      method: 'POST',
      data,
      header: Object.assign({ 'content-type': 'application/json' }, header || {}),
      timeout: 15000,
      success: (res) => {
        if (res.statusCode >= 500) reject(new Error('server ' + res.statusCode))
        else resolve(res.data || {})
      },
      fail: reject
    })
  })
}

function login() {
  if (!loggingIn) {
    loggingIn = new Promise((resolve, reject) => {
      wx.login({ success: (r) => resolve(r.code), fail: reject })
    }).then((code) => request('/api/login', { code })).then((res) => {
      if (!res.ok) throw new ApiError(res.msg || '登录失败', res.code)
      token = res.data.token
      wx.setStorageSync(TOKEN_KEY, token)
      return token
    })
    loggingIn.then(() => { loggingIn = null }, () => { loggingIn = null })
  }
  return loggingIn
}

function call(name, action, data, retried) {
  const ready = token ? Promise.resolve(token) : login()
  return ready.then((t) => request('/api/' + name, fixUrls(Object.assign({ action }, data || {}), toPath), { 'x-session': t })).then((result) => {
    if (!result.ok) {
      if (result.code === 'NEED_WX_LOGIN' && !retried) {
        token = ''
        wx.removeStorageSync(TOKEN_KEY)
        return call(name, action, data, true)
      }
      throw new ApiError(result.msg || '操作失败', result.code)
    }
    return fixUrls(result.data, toFull)
  })
}

// 员工上传图片，返回能直接显示的完整地址；folder 是 products（商品图）或 covers（书封面）
function upload(filePath, folder) {
  const ready = token ? Promise.resolve(token) : login()
  return ready.then((t) => new Promise((resolve, reject) => {
    if (!base()) return reject(new ApiError('还没填服务器地址：打开 miniprogram/config.js 填 apiBase', 'NO_SERVER'))
    wx.uploadFile({
      url: base() + '/api/upload?folder=' + folder,
      filePath,
      name: 'file',
      header: { 'x-session': t },
      success: (res) => {
        let result = {}
        try {
          result = JSON.parse(res.data)
        } catch (e) {
          return reject(new Error('upload ' + res.statusCode))
        }
        if (!result.ok) return reject(new ApiError(result.msg || '上传失败', result.code))
        resolve(toFull(result.data.fileID))
      },
      fail: reject
    })
  }))
}

function errorText(err) {
  if (err && err.code) return err.message
  const raw = String((err && (err.errMsg || err.message)) || '')
  if (/url not in domain list|合法域名/i.test(raw)) return '服务器域名还没加到小程序后台的合法域名里'
  if (/server 5/.test(raw)) return '服务器开小差了，请稍后再试'
  return '网络不太好，请稍后再试'
}

function toastError(err) {
  if (err && !err.code) console.error(err)
  wx.showToast({ title: errorText(err), icon: 'none', duration: 2500 })
}

module.exports = {
  common: (action, data) => call('common', action, data),
  coffee: (action, data) => call('coffee', action, data),
  book: (action, data) => call('book', action, data),
  upload,
  base,
  errorText,
  toastError
}
