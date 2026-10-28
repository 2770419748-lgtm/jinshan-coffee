const api = require('../../utils/api')

Page({
  data: {
    orders: [],
    hasMore: false,
    loaded: false
  },

  onShow() {
    this.load(true)
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore) this.load(false)
  },

  load(reset) {
    if (reset) this.page = 0
    return api.carwash('myOrders', { page: this.page }).then((res) => {
      this.page++
      this.setData({ orders: reset ? res.orders : this.data.orders.concat(res.orders), hasMore: res.hasMore, loaded: true })
    }).catch((err) => {
      this.setData({ loaded: true })
      api.toastError(err)
    })
  },

  more() {
    this.load(false)
  },

  open(e) {
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + e.currentTarget.dataset.id })
  }
})
