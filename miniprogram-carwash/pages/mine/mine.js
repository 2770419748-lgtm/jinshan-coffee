const api = require('../../utils/api')
const session = require('../../utils/session')
const guard = require('../../utils/guard')
const config = require('../../config')

Page({
  data: {
    shopName: config.shopName,
    user: null,
    isStaff: false,
    member: null,
    phone: ''
  },

  onShow() {
    session.getUser(true).then((user) => {
      this.setData({ user, isStaff: guard.isStaff(user.staff) })
    }).catch(api.toastError)
    api.carwash('getHome').then((home) => this.setData({ member: home.member, phone: home.shop.phone })).catch(() => {})
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  goCards() {
    wx.navigateTo({ url: '/pages/cards/cards' })
  },

  goVouchers() {
    wx.navigateTo({ url: '/pages/vouchers/vouchers' })
  },

  goAddresses() {
    wx.navigateTo({ url: '/pages/addresses/addresses' })
  },

  goStaff() {
    wx.navigateTo({ url: '/staff/pages/orders/orders' })
  },

  callShop() {
    wx.makePhoneCall({ phoneNumber: this.data.phone, fail: () => {} })
  },

  bindStaff() {
    wx.navigateTo({ url: '/pages/bind/bind' })
  }
})
