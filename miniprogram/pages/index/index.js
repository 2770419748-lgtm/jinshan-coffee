const api = require('../../utils/api')
const table = require('../../utils/table')
const reserve = require('../../utils/reserve')
const delivery = require('../../utils/delivery')
const starUtil = require('../../utils/stars')

Page({
  data: {
    tableNo: '',
    banners: [],
    current: 0,
    hours: null,
    reserveEnabled: false,
    delivery: null, // 外送：{ enabled, inHours, hours, minOrder }，店里没开时 enabled 是 false，不显示入口
    claimable: 0,
    member: null, // 会员卡：{ enabled, balance, isMember, memberUntil, freeCategories, promo }，没开储值又没余额时是 null
    memberText: '',
    stars: null, // 集星卡：{ stars, need }，没开集星时是 null
    starDots: [],
    starTip: '',
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

  // 轮播、营业时间、能不能预约、有没有外送、还有几种券可以领、会员卡、集星卡
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
        delivery: home.delivery && home.delivery.enabled ? home.delivery : null,
        claimable: home.claimableCoupons,
        member: m,
        memberText,
        stars: home.stars,
        starDots: home.stars ? starUtil.dots(home.stars.stars, home.stars.need) : [],
        starTip: home.stars ? starUtil.tip(home.stars.stars, home.stars.need) : ''
      })
    }).catch(() => {})
  },

  // 首页提示还没取的订单
  loadActiveOrder() {
    return api.coffee('myOrders', { page: 0 }).then(({ orders }) => {
      const active = orders.find((o) => o.status === 'pending' || o.status === 'making')
      let text = ''
      if (active) {
        if (active.awaitingPay && active.payStatus === 'unpaid') text = (active.mode === 'delivery' ? '外送单' : '预约单') + '还没付款，15 分钟内没付会自动取消'
        else if (active.delivery) text = active.delivery.statusText === '待配送' ? (active.status === 'making' ? '外送单正在制作' : '外送单已下单') : active.delivery.statusText
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
    delivery.off()
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
    delivery.off()
    reserve.on()
    wx.switchTab({ url: '/pages/menu/menu' })
  },

  // 外送：送到家，要在线付款；不在外送时间也能先看看菜单
  deliver() {
    const d = this.data.delivery
    if (!d) return
    const go = () => {
      table.clear()
      reserve.off()
      delivery.on()
      wx.switchTab({ url: '/pages/menu/menu' })
    }
    if (d.inHours) {
      go()
      return
    }
    wx.showModal({
      title: '现在不在外送时间',
      content: '外送时间 ' + d.hours.open + '–' + d.hours.close + '，现在下不了外送单。可以先看看菜单，或者到店自取。',
      confirmText: '看看菜单',
      success: (res) => {
        if (res.confirm) go()
      }
    })
  },

  goCoupons() {
    wx.navigateTo({ url: '/pages/coupons/coupons' })
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  goStars() {
    wx.navigateTo({ url: '/pages/stars/stars' })
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
