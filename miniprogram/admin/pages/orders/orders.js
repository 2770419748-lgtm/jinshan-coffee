const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

// 停留在这个页面时每 8 秒查一次新订单，有新单就响铃并震动
const POLL_MS = 8000

function cancelText(order) {
  // 用星换的单，取消后星星退回
  const stars = order.starRedeem ? '用掉的 ' + order.starRedeem.stars + ' 颗星会退回给顾客。' : ''
  if (order.payStatus !== 'paid') return '确定取消这单？' + stars
  if (order.payMethod === 'wechat') return '这单是微信支付的，取消后钱会原路退回顾客的微信。' + stars
  if (order.payMethod === 'voucher') return '这单全部用券或星星抵扣，取消后券和星星会退回给顾客。'
  if (order.payMethod === 'balance') return '这单是会员余额付的，取消后钱会退回顾客的余额。' + stars
  return '这单已在吧台收款，取消后请记得线下退款给顾客。' + stars
}

Page({
  data: {
    tabs: [
      { key: 'pending', name: '待制作' },
      { key: 'making', name: '制作中' },
      { key: 'done', name: '已完成' },
      { key: 'cancelled', name: '已取消' }
    ],
    current: 'pending',
    orders: [],
    counts: {},
    loading: true,
    ready: false,
    soundOn: true
  },

  onLoad() {
    this.knownPending = null
    this.audio = wx.createInnerAudioContext()
    this.audio.src = '/admin/assets/new-order.wav'
  },

  onShow() {
    guard.loadStaff(guard.COFFEE_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      wx.setKeepScreenOn({ keepScreenOn: true })
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
    wx.setKeepScreenOn({ keepScreenOn: false })
  },

  load(silent) {
    if (this.busy) return Promise.resolve()
    this.busy = true
    const status = this.data.current
    return api.coffee('listOrders', { status }).then(({ orders, counts, pendingIds }) => {
      this.checkNew(pendingIds)
      if (status !== this.data.current) return // 加载期间切了标签
      this.setData({ orders, counts, loading: false })
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
      if (fresh.length) this.ring(fresh.length)
    }
    const known = this.knownPending || {}
    ids.forEach((id) => { known[id] = true })
    this.knownPending = known
  },

  ring(count) {
    wx.vibrateLong()
    if (this.data.soundOn && this.audio) {
      this.audio.stop()
      this.audio.play()
    }
    wx.showToast({ title: '来了 ' + count + ' 个新订单', icon: 'none' })
  },

  toggleSound() {
    this.setData({ soundOn: !this.data.soundOn })
  },

  switchTab(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.current) return
    this.setData({ current: key, orders: [], loading: true })
    this.busy = false
    this.load()
  },

  act(e) {
    const { id, op } = e.currentTarget.dataset
    const run = () => {
      const call = op === 'paid'
        ? api.coffee('markPaid', { id })
        : api.coffee('setOrderStatus', { id, status: op })
      wx.showLoading({ title: '处理中', mask: true })
      call.then(() => {
        wx.hideLoading()
        this.busy = false
        this.load()
      }).catch((err) => {
        wx.hideLoading()
        api.toastError(err)
        this.busy = false
        this.load(true)
      })
    }
    if (op === 'cancelled') {
      const order = this.data.orders.find((o) => o._id === id) || {}
      wx.showModal({
        title: '取消订单',
        content: cancelText(order),
        confirmText: '取消订单',
        cancelText: '不取消',
        success: (res) => { if (res.confirm) run() }
      })
      return
    }
    run()
  }
})
