const api = require('../../utils/api')
const config = require('../../config')

Page({
  data: {
    shopName: config.shopName,
    shop: null,
    bookingOpen: false,
    services: [],
    member: null,
    loaded: false
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.carwash('getHome').then((home) => {
      this.setData({ shop: home.shop, bookingOpen: home.bookingOpen, services: home.services, member: home.member, loaded: true })
    }).catch((err) => {
      this.setData({ loaded: true })
      api.toastError(err)
    })
  },

  book(e) {
    if (!this.data.bookingOpen) {
      wx.showToast({ title: '店里暂时没开放线上预约', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/book/book?id=' + e.currentTarget.dataset.id })
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  openMap() {
    const s = this.data.shop
    if (!s || !s.location) return
    wx.openLocation({ latitude: s.location.lat, longitude: s.location.lng, name: s.shopName || config.shopName, address: s.address, scale: 16 })
  },

  callShop() {
    wx.makePhoneCall({ phoneNumber: this.data.shop.phone, fail: () => {} })
  }
})
