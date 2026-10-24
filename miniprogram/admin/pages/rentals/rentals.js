const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

// 停在这个页面时每 15 秒刷新一次，有新的借书单就响铃震动
const POLL_MS = 15000

Page({
  data: {
    tabs: [
      { key: 'pending', name: '待取书' },
      { key: 'reading', name: '在读' },
      { key: 'returned', name: '已归还' },
      { key: 'cancelled', name: '已取消' }
    ],
    current: 'pending',
    rentals: [],
    counts: {},
    now: 0,
    loading: true,
    ready: false
  },

  onLoad() {
    this.knownPending = null
    this.offset = 0
    this.audio = wx.createInnerAudioContext()
    this.audio.src = '/admin/assets/new-order.wav'
  },

  onShow() {
    guard.loadStaff(guard.BOOK_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      this.load()
      this.stopPolling()
      this.timer = setInterval(() => this.load(true), POLL_MS)
    })
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
    if (this.audio) this.audio.destroy()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  stopPolling() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  load(silent) {
    if (this.busy) return Promise.resolve()
    this.busy = true
    const status = this.data.current
    return api.book('listRentals', { status }).then(({ rentals, counts, pendingIds, serverNow }) => {
      this.checkNew(pendingIds)
      this.offset = serverNow - Date.now()
      if (status !== this.data.current) return
      this.setData({ rentals, counts, now: serverNow, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      if (!silent) api.toastError(err)
    }).then(() => {
      this.busy = false
    })
  },

  checkNew(pendingIds) {
    const ids = pendingIds || []
    if (this.knownPending) {
      const fresh = ids.filter((id) => !this.knownPending[id])
      if (fresh.length) {
        wx.vibrateLong()
        this.audio.stop()
        this.audio.play()
        wx.showToast({ title: '来了 ' + fresh.length + ' 个借书单', icon: 'none' })
      }
    }
    const known = this.knownPending || {}
    ids.forEach((id) => { known[id] = true })
    this.knownPending = known
  },

  switchTab(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.current) return
    this.setData({ current: key, rentals: [], loading: true })
    this.busy = false
    this.load()
  },

  find(id) {
    return this.data.rentals.find((r) => r._id === id)
  },

  run(action, id, done) {
    wx.showLoading({ title: '处理中', mask: true })
    return api.book(action, { id }).then((res) => {
      wx.hideLoading()
      if (done) done(res)
    }).catch((err) => {
      wx.hideLoading()
      api.toastError(err)
    }).then(() => {
      this.busy = false
      this.load(true)
    })
  },

  markPaid(e) {
    this.run('markRentalPaid', e.currentTarget.dataset.id, (res) => {
      wx.showToast({ title: res.voucherCount ? '已收款，送了 ' + res.voucherCount + ' 张赠饮券' : '已收款', icon: 'none' })
    })
  },

  handOut(e) {
    const rental = this.find(e.currentTarget.dataset.id)
    wx.showModal({
      title: '交书',
      content: '把《' + rental.bookTitle + '》交给 ' + rental.code + ' 号顾客，' + (rental.ruleType === 'hourly' ? '现在开始计时 ' + rental.hours + ' 小时。' : '今天打烊前还。'),
      confirmText: '已交书',
      success: (res) => {
        if (res.confirm) this.run('handOut', rental._id)
      }
    })
  },

  returnBook(e) {
    const rental = this.find(e.currentTarget.dataset.id)
    wx.showModal({
      title: '还书',
      content: '确认《' + rental.bookTitle + '》已经还回来了？',
      confirmText: '已还书',
      success: (res) => {
        if (!res.confirm) return
        this.run('returnBook', rental._id, (r) => {
          if (!r.overtimeFee) {
            wx.showToast({ title: '已还书', icon: 'success' })
            return
          }
          wx.showModal({
            title: '要收超时费',
            content: '超时 ' + r.overtimeMinutes + ' 分钟，按 ' + r.overtimeHours + ' 小时算，要补 ¥' + r.overtimeFee / 100 + '。收到后在「已归还」里点「超时费已收」。',
            showCancel: false
          })
        })
      }
    })
  },

  markOvertimePaid(e) {
    this.run('markOvertimePaid', e.currentTarget.dataset.id, () => {
      wx.showToast({ title: '已收超时费', icon: 'success' })
    })
  },

  cancel(e) {
    const rental = this.find(e.currentTarget.dataset.id)
    wx.showModal({
      title: '取消借阅',
      content: rental.status === 'reading' ? '书会放回书架，确认书已经拿回来了。' : '书会放回书架。',
      confirmText: '取消借阅',
      cancelText: '不取消',
      success: (res) => {
        if (!res.confirm) return
        this.run('adminCancelRental', rental._id, (r) => {
          if (!r.paid) return
          wx.showModal({
            title: '记得退款',
            content: '这单已收款 ¥' + rental.fee / 100 + '，请线下退给顾客。' + (r.voidedVouchers ? '没用的 ' + r.voidedVouchers + ' 张赠饮券已作废。' : ''),
            showCancel: false
          })
        })
      }
    })
  }
})
