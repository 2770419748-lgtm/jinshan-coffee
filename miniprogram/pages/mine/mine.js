const api = require('../../utils/api')
const session = require('../../utils/session')

Page({
  data: {
    user: null,
    member: null,
    loading: true
  },

  onShow() {
    session.getUser(true).then((user) => {
      this.setData({ user, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
    // 首页的会员卡数据：余额、会员到期日
    api.common('getHome').then((home) => this.setData({ member: home.member })).catch(() => {})
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' })
  },

  goRentals() {
    getApp().globalData.ordersTab = 'book'
    wx.switchTab({ url: '/pages/orders/orders' })
  },

  goVouchers() {
    wx.navigateTo({ url: '/pages/vouchers/vouchers' })
  },

  goCoupons() {
    wx.navigateTo({ url: '/pages/coupons/coupons' })
  },

  goAdmin() {
    wx.navigateTo({ url: '/admin/pages/home/home' })
  },

  bindOwner() {
    wx.navigateTo({ url: '/pages/bind/bind?type=owner' })
  },

  bindStaff() {
    wx.navigateTo({ url: '/pages/bind/bind?type=staff' })
  }
})
