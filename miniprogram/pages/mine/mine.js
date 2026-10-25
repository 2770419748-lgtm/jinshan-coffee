const api = require('../../utils/api')
const session = require('../../utils/session')

Page({
  data: {
    user: null,
    loading: true
  },

  onShow() {
    session.getUser(true).then((user) => {
      this.setData({ user, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
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
