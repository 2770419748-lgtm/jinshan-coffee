const api = require('../../utils/api')

Page({
  data: {
    usable: [],
    others: [],
    loading: true
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.coffee('myVouchers').then(({ usable, others }) => {
      this.setData({ usable, others, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  goMenu() {
    wx.switchTab({ url: '/pages/menu/menu' })
  },

  goCoupons() {
    wx.navigateTo({ url: '/pages/coupons/coupons' })
  }
})
