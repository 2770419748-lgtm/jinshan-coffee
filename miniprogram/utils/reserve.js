// 预约点单：首页点「预约」后记在本地，去菜单点好、结算时选取餐时间。2 小时内有效，下单或扫桌码后清掉
const KEY = 'jinshan_reserve'
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
