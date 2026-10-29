const api = require('../../utils/api')
const session = require('../../utils/session')
const server = require('../../utils/server')
const cart = require('../../utils/cart')

Page({
  data: {
    user: null,
    member: null,
    stars: null, // 集星：{ stars, need }，没开集星时是 null
    delivery: false, // 店里开了外送才显示「收货地址」
    server: '', // 开发版、体验版：现在连的是 test 还是 prod；正式版是空的，不显示切换
    loading: true
  },

  onShow() {
    this.setData({ server: server.canSwitch() ? server.current() : '' })
    session.getUser(true).then((user) => {
      this.setData({ user, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
    // 首页的会员卡和集星卡数据：余额、会员到期日、几颗星
    api.common('getHome').then((home) => this.setData({ member: home.member, stars: home.stars, delivery: !!(home.delivery && home.delivery.enabled) })).catch(() => {})
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  goStars() {
    wx.navigateTo({ url: '/pages/stars/stars' })
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

  goAddresses() {
    wx.navigateTo({ url: '/pages/addresses/addresses' })
  },

  goAdmin() {
    wx.navigateTo({ url: '/admin/pages/home/home' })
  },

  bindOwner() {
    wx.navigateTo({ url: '/pages/bind/bind?type=owner' })
  },

  bindStaff() {
    wx.navigateTo({ url: '/pages/bind/bind?type=staff' })
  },

  // 开发版、体验版切换正式 / 测试服务器；两边的商品不一样，购物车清掉
  switchServer() {
    const to = server.current() === 'test' ? 'prod' : 'test'
    wx.showModal({
      title: to === 'prod' ? '切到正式服务器？' : '切回测试服务器？',
      content: to === 'prod'
        ? '切过去以后下单、改菜单、出餐都是店里的真数据。只对这台手机有效，随时可以切回来。'
        : '测试服务器的数据和正式版分开，随便下单也不影响店里。',
      confirmText: '切换',
      success: (r) => {
        if (!r.confirm) return
        server.set(to)
        cart.clear()
        session.clearUser()
        wx.reLaunch({ url: '/pages/index/index' })
      }
    })
  }
})
