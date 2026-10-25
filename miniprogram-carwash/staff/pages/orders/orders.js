const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

// 北京时间的日期
function cnDay(ms) {
  return new Date((ms || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

Page({
  data: {
    staff: null,
    scope: 'todo',
    today: '',
    tomorrow: '',
    day: '',
    orders: [],
    loaded: false
  },

  onLoad() {
    const today = cnDay()
    this.setData({ today, tomorrow: cnDay(Date.now() + 24 * 3600 * 1000), day: today })
    guard.loadStaff().then((staff) => {
      if (!staff) return
      this.setData({ staff })
      this.load()
    })
  },

  onShow() {
    if (this.data.staff) this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const { day, scope } = this.data
    return api.carwash('staffOrders', { day, scope }).then((res) => {
      this.setData({ orders: res.orders, loaded: true })
    }).catch((err) => {
      this.setData({ loaded: true })
      api.toastError(err)
    })
  },

  pickScope(e) {
    this.setData({ scope: e.currentTarget.dataset.scope, orders: [], loaded: false })
    this.load()
  },

  pickDay(e) {
    this.setData({ day: e.currentTarget.dataset.day, orders: [], loaded: false })
    this.load()
  },

  onDay(e) {
    this.setData({ day: e.detail.value, orders: [], loaded: false })
    this.load()
  },

  open(e) {
    wx.navigateTo({ url: '/staff/pages/order/order?id=' + e.currentTarget.dataset.id })
  },

  goCounter() {
    wx.navigateTo({ url: '/staff/pages/counter/counter' })
  },

  goWeb() {
    wx.navigateTo({ url: '/staff/pages/web-account/web-account' })
  }
})
