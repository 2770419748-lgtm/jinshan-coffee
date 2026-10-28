// 桌号：扫桌码后记在本地，4 小时内有效。扫了桌码就不是预约了
const reserve = require('./reserve')

const KEY = 'jinshan_table'
const TTL = 4 * 3600 * 1000

function fromScene(scene) {
  if (!scene) return ''
  const text = decodeURIComponent(String(scene))
  const m = text.match(/(?:^|&)t=([A-Za-z0-9-]{1,8})(?:&|$)/)
  return m ? m[1] : ''
}

// 页面或 App 的 query：正式桌码是 { scene: 't%3D5' }，开发时也可以直接用 { t: '5' }
function parseQuery(query) {
  if (!query) return ''
  if (query.t && /^[A-Za-z0-9-]{1,8}$/.test(String(query.t))) return String(query.t)
  return fromScene(query.scene)
}

// wx.scanCode 扫小程序码得到的 path，例如 pages/menu/menu?scene=t%3D5
function parsePath(path) {
  if (!path) return ''
  const i = String(path).indexOf('?')
  if (i === -1) return ''
  const query = {}
  String(path).slice(i + 1).split('&').forEach((pair) => {
    const [k, v] = pair.split('=')
    if (k) query[k] = v || ''
  })
  return parseQuery(query)
}

function set(tableNo) {
  wx.setStorageSync(KEY, { tableNo: String(tableNo), at: Date.now() })
  reserve.off()
}

function get() {
  try {
    const v = wx.getStorageSync(KEY)
    if (!v || !v.tableNo || Date.now() - v.at > TTL) return ''
    return v.tableNo
  } catch (e) {
    return ''
  }
}

function clear() {
  wx.removeStorageSync(KEY)
}

module.exports = { fromScene, parseQuery, parsePath, set, get, clear }
