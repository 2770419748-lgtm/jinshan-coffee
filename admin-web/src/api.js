// 调自己的服务器：网页后台和接口在同一个域名下（网页在 /admin/，接口在 /api/）。
// 员工登录后每次调用带上 webToken；本地预览（npm run mock）时连的是用假数据跑的同一套服务器代码。
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

// 接口地址：默认和网页同一个域名；网页单独放别处时在 config.js 里填 apiBase
function apiUrl(path) {
  return String(config().apiBase || '').replace(/\/+$/, '') + path
}

const needLoginHandlers = []
export function onNeedLogin(fn) {
  needLoginHandlers.push(fn)
}

async function post(path, body, headers) {
  let res
  try {
    res = await fetch(apiUrl(path), { method: 'POST', headers, body })
  } catch (e) {
    console.error(e)
    throw new ApiError('网络不太好，请稍后再试', 'NETWORK')
  }
  if (res.status >= 500) throw new ApiError('服务器开小差了，请稍后再试', 'SERVER_ERROR')
  if (res.status === 404) throw new ApiError('服务器上找不到接口，检查一下服务器有没有启动', 'NOT_FOUND')
  try {
    return await res.json()
  } catch (e) {
    throw new ApiError('服务器返回的内容看不懂，检查一下网站配置', 'BAD_RESPONSE')
  }
}

function check(result, action) {
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

export async function call(name, action, data) {
  const payload = Object.assign({ action }, data || {})
  if (session.token) payload.webToken = session.token
  const result = await post('/api/' + name, JSON.stringify(payload), { 'content-type': 'application/json' })
  return check(result, action)
}

// 本地预览没有手机：用店主身份模拟扫码确认
export const isMock = MOCK
export async function mockConfirmLogin(id) {
  const result = await post('/mock/confirm-login', JSON.stringify({ id }), { 'content-type': 'application/json' })
  check(result, 'mockConfirmLogin')
}

export const api = {
  common: (action, data) => call('common', action, data),
  coffee: (action, data) => call('coffee', action, data),
  book: (action, data) => call('book', action, data),
  member: (action, data) => call('member', action, data),
  carwash: (action, data) => call('carwash', action, data)
}

// ---------- 图片：上传到服务器，返回 /uploads/ 开头的地址 ----------

export async function uploadImage(file, folder) {
  const form = new FormData()
  form.append('file', file)
  const result = await post('/api/upload?folder=' + encodeURIComponent(folder), form, { 'x-web-token': session.token })
  return check(result, 'upload').fileID
}

// 图片地址：/uploads/ 开头的是自己服务器上的，网页单独放别处时补上接口地址
export function imageUrl(fileID) {
  if (!fileID) return ''
  return fileID.startsWith('/uploads/') ? apiUrl(fileID) : fileID
}
