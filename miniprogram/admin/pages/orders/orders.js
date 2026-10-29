const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

// 停留在这个页面时每 8 秒查一次新订单，有新单就响铃并震动
const POLL_MS = 8000

function cancelText(order) {
  // 用星换的单，取消后星星退回；已经叫了骑手的外送单先取消骑手
  const d = order.delivery
  const courier = d && d.provider !== 'self' && ['calling', 'accepted', 'arrived', 'delivering', 'abnormal'].indexOf(d.status) !== -1
    ? '会先取消骑手，骑手接单后取消可能扣违约金。' : ''
  const stars = courier + (order.starRedeem ? '用掉的 ' + order.starRedeem.stars + ' 颗星会退回给顾客。' : '')
  if (order.payStatus !== 'paid') return '确定取消这单？' + stars
  if (order.payMethod === 'wechat') return '这单是微信支付的，取消后钱会原路退回顾客的微信。' + stars
  if (order.payMethod === 'voucher') return '这单全部用券或星星抵扣，取消后券和星星会退回给顾客。'
  if (order.payMethod === 'balance') return '这单是会员余额付的，取消后钱会退回顾客的余额。' + stars
  return '这单已在吧台收款，取消后请记得线下退款给顾客。' + stars
}

// 测试单模拟骑手：下一步是什么
const MOCK_NEXT = { calling: 'accepted', accepted: 'arrived', arrived: 'delivering', delivering: 'delivered' }
const MOCK_TEXT = { accepted: '骑手接单', arrived: '骑手到店', delivering: '骑手取货', delivered: '送达' }

// 外送单能点哪些配送按钮
function deliveryOps(order, courier) {
  const d = order.delivery
  if (!d || order.status === 'cancelled' || order.payStatus !== 'paid') return null
  const ops = {}
  if (d.status === 'waiting' || d.status === 'cancelled') {
    ops.call = !!(courier && courier.external && courier.ready)
    ops.self = true
  }
  if (['calling', 'accepted', 'arrived', 'abnormal'].indexOf(d.status) !== -1) ops.cancel = true
  if (d.provider === 'self' ? d.status === 'delivering' : (d.status === 'delivering' || d.status === 'abnormal')) ops.delivered = true
  if (d.provider !== 'self' && ['calling', 'accepted', 'arrived', 'delivering', 'abnormal'].indexOf(d.status) !== -1) ops.refresh = true
  if (d.sandbox && MOCK_NEXT[d.status]) {
    ops.mock = MOCK_NEXT[d.status]
    ops.mockText = MOCK_TEXT[ops.mock]
  }
  return ops
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
    courier: null, // 外送设置里选的配送方式：{ provider, name, external, ready, sandbox }
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
    return api.coffee('listOrders', { status }).then(({ orders, counts, pendingIds, courier }) => {
      this.checkNew(pendingIds)
      if (status !== this.data.current) return // 加载期间切了标签
      orders.forEach((o) => { o.ops = deliveryOps(o, courier) })
      this.setData({ orders, counts, courier, loading: false })
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

  // 外送：叫骑手、店员送出、取消配送、已送达、刷新进度、测试单模拟骑手
  courierAct(e) {
    const { id, op } = e.currentTarget.dataset
    const order = this.data.orders.find((o) => o._id === id)
    if (!order) return
    const run = (name, params, title) => {
      wx.showLoading({ title: title || '处理中', mask: true })
      return api.coffee(name, Object.assign({ id }, params || {})).then(() => {
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
    if (op === 'call') {
      // 先估运费，店员确认了再叫
      wx.showLoading({ title: '估运费', mask: true })
      api.coffee('courierQuote', { id }).then((q) => {
        wx.hideLoading()
        wx.showModal({
          title: '叫骑手',
          content: '预计运费 ¥' + (q.fee / 100).toFixed(2) + (q.carrierName ? '（' + q.carrierName + '）' : '') + '，从门店的运费余额里扣。骑手接单后再取消可能扣违约金。',
          confirmText: '叫骑手',
          success: (res) => { if (res.confirm) run('callCourier', { provider: this.data.courier.provider }, '叫骑手') }
        })
      }).catch((err) => {
        wx.hideLoading()
        api.toastError(err)
      })
      return
    }
    if (op === 'self') {
      wx.showModal({
        title: '店员送',
        content: '确定由店员自己送这单吗？东西出门后点，送到了再点「已送达」。',
        confirmText: '送出了',
        success: (res) => { if (res.confirm) run('callCourier', { provider: 'self' }) }
      })
      return
    }
    if (op === 'cancel') {
      wx.showModal({
        title: '取消配送',
        content: '订单不取消，只是不让这个骑手送了，之后可以重新叫或者店员送。骑手已经接单的，配送公司可能扣违约金。',
        confirmText: '取消配送',
        cancelText: '不取消',
        success: (res) => { if (res.confirm) run('cancelCourier') }
      })
      return
    }
    if (op === 'delivered') {
      wx.showModal({
        title: '已送达',
        content: '确定已经送到顾客手上了吗？',
        success: (res) => { if (res.confirm) run('markDelivered') }
      })
      return
    }
    if (op === 'refresh') return run('refreshCourier', null, '查进度')
    if (op === 'mock') return run('mockCourier', { status: order.ops.mock }, '模拟中')
  },

  callPhone(e) {
    wx.makePhoneCall({ phoneNumber: e.currentTarget.dataset.phone, fail: () => {} })
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
