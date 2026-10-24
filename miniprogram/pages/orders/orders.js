const api = require('../../utils/api')

Page({
  data: {
    orders: [],
    loading: true,
    hasMore: false
  },

  onShow() {
    this.reload()
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadPage(this.page + 1)
  },

  reload() {
    return this.loadPage(0)
  },

  loadPage(page) {
    this.setData({ loading: true })
    return api.coffee('myOrders', { page }).then(({ orders, hasMore }) => {
      this.page = page
      this.setData({
        orders: page === 0 ? orders : this.data.orders.concat(orders),
        hasMore,
        loading: false
      })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  open(e) {
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + e.currentTarget.dataset.id })
  }
})
