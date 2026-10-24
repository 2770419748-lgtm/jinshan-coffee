const api = require('../../utils/api')

const POLL_MS = 15000
const TICK_MS = 30000
const STEP = { pending: 1, reading: 2, returned: 3 }

Page({
  data: {
    rental: null,
    step: 0,
    now: 0,
    loading: true
  },

  onLoad(options) {
    this.id = options.id
    this.offset = 0 // 手机时间和服务器时间的差
    this.load()
  },

  onShow() {
    this.startTimers()
  },

  onHide() {
    this.stopTimers()
  },

  onUnload() {
    this.stopTimers()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 还没还书时定时刷新状态；倒计时每 30 秒走一次
  startTimers() {
    this.stopTimers()
    this.poll = setInterval(() => {
      const r = this.data.rental
      if (r && (r.status === 'pending' || r.status === 'reading')) this.load()
    }, POLL_MS)
    this.tick = setInterval(() => this.setData({ now: Date.now() + this.offset }), TICK_MS)
  },

  stopTimers() {
    if (this.poll) clearInterval(this.poll)
    if (this.tick) clearInterval(this.tick)
    this.poll = null
    this.tick = null
  },

  load() {
    return api.book('getRental', { id: this.id }).then((rental) => {
      this.offset = rental.serverNow - Date.now()
      this.setData({ rental, step: STEP[rental.status] || 0, now: rental.serverNow, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  cancel() {
    wx.showModal({
      title: '取消借书',
      content: '确定不借这本书了吗？',
      confirmText: '取消借书',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        api.book('cancelRental', { id: this.id })
          .then(() => this.load())
          .catch(api.toastError)
      }
    })
  },

  goMenu() {
    wx.switchTab({ url: '/pages/menu/menu' })
  },

  goVouchers() {
    wx.navigateTo({ url: '/pages/vouchers/vouchers' })
  },

  goShelf() {
    wx.switchTab({ url: '/pages/books/books' })
  }
})
