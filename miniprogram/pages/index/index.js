const api = require('../../utils/api')
const table = require('../../utils/table')
const reserve = require('../../utils/reserve')

Page({
  data: {
    tableNo: '',
    banners: [],
    current: 0,
    hours: null,
    reserveEnabled: false,
    claimable: 0,
    member: null, // 会员卡：{ enabled, balance, isMember, memberUntil, freeCategories, promo }，没开储值又没余额时是 null
    memberText: '',
    activeOrder: null,
    activeText: '',
    activeRental: null
  },

  onShow() {
    this.setData({ tableNo: table.get() })
    this.loadHome()
    this.loadActiveOrder()
    this.loadActiveRental()
  },

  onPullDownRefresh() {
    Promise.all([this.loadHome(), this.loadActiveOrder(), this.loadActiveRental()])
      .then(() => wx.stopPullDownRefresh())
  },

  // 轮播、营业时间、能不能预约、还有几种券可以领、会员卡
  loadHome() {
    return api.common('getHome').then((home) => {
      const m = home.member
      let memberText = ''
      if (m && m.isMember) memberText = m.memberUntil + ' 到期' + (m.freeCategories.length ? '，' + m.freeCategories.join('、') + '免费看' : '')
      else if (m) memberText = m.promo || '储值点单、借书都能用'
      this.setData({
        banners: home.banners,
        current: 0,
        hours: home.hours,
        reserveEnabled: home.reserveEnabled,
        claimable: home.claimableCoupons,
        member: m,
        memberText
      })
    }).catch(() => {})
  },

  // 首页提示还没取的订单
  loadActiveOrder() {
    return api.coffee('myOrders', { page: 0 }).then(({ orders }) => {
      const active = orders.find((o) => o.status === 'pending' || o.status === 'making')
      let text = ''
      if (active) {
        if (active.awaitingPay && active.payStatus === 'unpaid') text = '预约单还没付款，15 分钟内没付会自动取消'
        else if (active.status === 'making') text = '你的订单正在制作'
        else if (active.reserveAt) text = '已预约，到点来取'
        else text = '你的订单已下单'
      }
      this.setData({ activeOrder: active || null, activeText: text })
    }).catch(() => {})
  },

  // 正在看或者还没取的书
  loadActiveRental() {
    return api.book('myRentals', { page: 0 }).then(({ rentals }) => {
      const active = rentals.find((r) => r.status === 'reading') || rentals.find((r) => r.status === 'pending')
      this.setData({ activeRental: active || null })
    }).catch(() => {})
  },

  onSlide(e) {
    this.setData({ current: e.detail.current })
  },

  openBanner(e) {
    const banner = this.data.banners[e.currentTarget.dataset.index]
    if (!banner) return
    if (banner.kind === 'product') {
      getApp().globalData.focusProduct = banner.targetId
      wx.switchTab({ url: '/pages/menu/menu' })
    } else if (banner.kind === 'book') {
      wx.navigateTo({ url: '/pages/book-detail/book-detail?id=' + banner.targetId })
    } else if (banner.kind === 'coupons') {
      this.goCoupons()
    }
  },

  // 吧台自取：不带桌号，做好凭取餐号到吧台取
  pickup() {
    table.clear()
    reserve.off()
    wx.switchTab({ url: '/pages/menu/menu' })
  },

  scan() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['wxCode', 'qrCode'],
      success: (res) => {
        const tableNo = table.parsePath(res.path)
        if (!tableNo) {
          wx.showToast({ title: '这不是本店的桌码', icon: 'none' })
          return
        }
        table.set(tableNo)
        wx.switchTab({ url: '/pages/menu/menu' })
      }
    })
  },

  // 预约：要先在线付款（微信支付或会员余额），店里开通以后才能用
  reserve() {
    if (!this.data.reserveEnabled) {
      wx.showModal({
        title: '预约暂未开放',
        content: '预约要先在线付款，店里开通以后就能用了。现在可以直接点单，做好到吧台取。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    table.clear()
    reserve.on()
    wx.switchTab({ url: '/pages/menu/menu' })
  },

  goCoupons() {
    wx.navigateTo({ url: '/pages/coupons/coupons' })
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  goVouchers() {
    wx.navigateTo({ url: '/pages/vouchers/vouchers' })
  },

  goBooks() {
    wx.switchTab({ url: '/pages/books/books' })
  },

  openRental() {
    wx.navigateTo({ url: '/pages/rental-detail/rental-detail?id=' + this.data.activeRental._id })
  },

  openOrder() {
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + this.data.activeOrder._id })
  },

  onShareAppMessage() {
    return { title: '进山咖啡', path: '/pages/index/index' }
  }
})
