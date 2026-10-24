// 调用云函数：正式环境用云开发 Web SDK（匿名登录 + 员工账号的 webToken），本地预览时走 mock 服务器
import cloudbase from '@cloudbase/js-sdk'
import { reactive } from 'vue'

const MOCK = import.meta.env.VITE_MOCK === '1'
const TOKEN_KEY = 'jinshan_web_token'

export class ApiError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

export const session = reactive({
  token: readToken(),
  staff: null
})

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch (e) {
    return ''
  }
}

export function setToken(token) {
  session.token = token || ''
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch (e) {
    // 浏览器禁用了本地存储时只在当前页面有效
  }
}

export function config() {
  return window.JINSHAN_CONFIG || {}
}

let app = null
let authReady = null

function cloudApp() {
  if (!app) {
    const env = config().envId
    if (!env) throw new ApiError('还没配置云开发环境 ID：打开网站目录里的 config.js，填上 envId', 'NO_ENV')
    app = cloudbase.init({ env })
  }
  return app
}

// 云开发要求先登录才能调云函数，这里用匿名登录；员工身份靠 webToken
function ensureAuth() {
  if (!authReady) {
    authReady = (async () => {
      const auth = cloudApp().auth({ persistence: 'local' })
      const state = await auth.getLoginState()
      if (!state) await auth.signInAnonymously()
    })().catch((e) => {
      authReady = null
      throw e
    })
  }
  return authReady
}

const needLoginHandlers = []
export function onNeedLogin(fn) {
  needLoginHandlers.push(fn)
}

function explain(err) {
  const raw = String((err && (err.message || err.errMsg)) || '')
  if (/FUNCTION_NOT_FOUND|FunctionName/i.test(raw)) return '云函数还没部署'
  if (/anonymous|ANONYMOUS|signIn/i.test(raw)) return '云开发没有开启匿名登录，请按说明文档开启'
  if (/domain|origin|CORS/i.test(raw)) return '这个网址没加到云开发的安全域名里'
  return '网络不太好，请稍后再试'
}

export async function call(name, action, data) {
  const payload = Object.assign({ action }, data || {})
  if (session.token) payload.webToken = session.token
  let result
  try {
    if (MOCK) {
      const res = await fetch('./mock/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, data: payload })
      })
      result = await res.json()
    } else {
      await ensureAuth()
      const res = await cloudApp().callFunction({ name, data: payload })
      result = res.result || {}
    }
  } catch (e) {
    if (e instanceof ApiError) throw e
    console.error(e)
    throw new ApiError(explain(e), 'NETWORK')
  }
  if (!result.ok) {
    if (result.code === 'NEED_LOGIN' && action !== 'webLogin') {
      setToken('')
      session.staff = null
      needLoginHandlers.forEach((fn) => fn())
    }
    throw new ApiError(result.msg || '操作失败', result.code)
  }
  return result.data
}

export const api = {
  common: (action, data) => call('common', action, data),
  coffee: (action, data) => call('coffee', action, data),
  book: (action, data) => call('book', action, data)
}

// ---------- 云存储：上传图片、把 cloud:// 换成能在网页里显示的地址 ----------

const mockFiles = {}
const urlCache = {}

export async function uploadImage(file, dir) {
  const ext = (file.name.match(/\.(\w+)$/) || [])[1] || 'jpg'
  const cloudPath = dir + '/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext.toLowerCase()
  if (MOCK) {
    const id = 'cloud://mock/' + cloudPath
    mockFiles[id] = URL.createObjectURL(file)
    return id
  }
  await ensureAuth()
  const res = await cloudApp().uploadFile({ cloudPath, filePath: file })
  return res.fileID
}

export async function tempUrl(fileID) {
  if (!fileID) return ''
  if (!fileID.startsWith('cloud://')) return fileID
  if (MOCK) return mockFiles[fileID] || ''
  if (urlCache[fileID]) return urlCache[fileID]
  await ensureAuth()
  const res = await cloudApp().getTempFileURL({ fileList: [fileID] })
  const url = (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) || ''
  if (url) urlCache[fileID] = url
  return url
}
