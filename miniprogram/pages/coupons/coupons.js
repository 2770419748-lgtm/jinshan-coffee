const api = require('../../utils/api')

Page({
  data: {
    coupons: [],
    loading: true,
    claiming: ''
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.coffee('couponCenter').then(({ coupons }) => {
      this.setData({ coupons, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  claim(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.claiming) return
    this.setData({ claiming: id })
    api.coffee('claimCoupon', { id }).then(() => {
      wx.showToast({ title: '领到了', icon: 'success' })
    }).catch(api.toastError).then(() => {
      this.setData({ claiming: '' })
      this.load()
    })
  },

  goMine() {
    wx.navigateTo({ url: '/pages/vouchers/vouchers' })
  },

  goMenu() {
    wx.switchTab({ url: '/pages/menu/menu' })
  }
})
