// 外送点单：首页点「外送」后记在本地，去菜单点好、结算时选收货地址。2 小时内有效，下单、扫桌码或选别的方式后清掉
const KEY = 'jinshan_delivery'
const TTL = 2 * 3600 * 1000

function on() {
  wx.setStorageSync(KEY, { at: Date.now() })
}

function active() {
  try {
    const v = wx.getStorageSync(KEY)
    return !!v && Date.now() - v.at <= TTL
  } catch (e) {
    return false
  }
}

function off() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) {
    // 没存过
  }
}

module.exports = { on, active, off }
