// 连哪台服务器：正式版连 config.apiBase（正式服务器）；开发版（开发者工具、预览）和体验版默认连 config.testApiBase（测试服务器），
// 测试的人随便下单也不影响店里的真数据。开发版、体验版可以在「我的」页面最下面切到正式服务器，只对这台手机有效。
// 没填 testApiBase 时都连正式服务器。
const config = require('../config')

const KEY = 'jinshan_server'

function envVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'release'
  } catch (e) {
    return 'release'
  }
}

const trim = (s) => String(s || '').replace(/\/+$/, '')

// 能不能切换：正式版不能，没有测试服务器也不能
function canSwitch() {
  return envVersion() !== 'release' && !!trim(config.testApiBase)
}

// 现在连的是哪台：'test' 或 'prod'
function current() {
  if (!canSwitch()) return 'prod'
  return wx.getStorageSync(KEY) === 'prod' ? 'prod' : 'test'
}

function set(name) {
  if (!canSwitch()) return
  if (name === 'prod') wx.setStorageSync(KEY, 'prod')
  else wx.removeStorageSync(KEY)
}

function base() {
  return current() === 'test' ? trim(config.testApiBase) : trim(config.apiBase)
}

module.exports = { envVersion, canSwitch, current, set, base }
