const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    loading: true,
    coupons: []
  },

  onShow() {
    guard.loadStaff(['owner']).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      this.load()
    })
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.coffee('adminListCoupons').then((coupons) => {
      this.setData({ coupons, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id
    const enabled = e.detail.value
    const patch = (value) => this.setData({ coupons: this.data.coupons.map((c) => (c._id === id ? Object.assign({}, c, { enabled: value }) : c)) })
    patch(enabled)
    api.coffee('setCouponFlags', { id, enabled }).catch((err) => {
      api.toastError(err)
      patch(!enabled)
    })
  },

  edit(e) {
    wx.navigateTo({ url: '/admin/pages/coupon-edit/coupon-edit?id=' + e.currentTarget.dataset.id })
  },

  add() {
    wx.navigateTo({ url: '/admin/pages/coupon-edit/coupon-edit' })
  },

  noop() {}
})
