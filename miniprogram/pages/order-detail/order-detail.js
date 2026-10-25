const api = require('../../utils/api')
const pay = require('../../utils/pay')

const POLL_MS = 10000
const STEP = { pending: 1, making: 2, done: 3 }

Page({
  data: {
    order: null,
    step: 0,
    loading: true
  },

  onLoad(options) {
    this.id = options.id
    this.load()
  },

  onShow() {
    this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 订单还没做好时每 10 秒刷新一次进度
  startPolling() {
    this.stopPolling()
    this.timer = setInterval(() => {
      const order = this.data.order
      if (order && (order.status === 'pending' || order.status === 'making')) this.load()
    }, POLL_MS)
  },

  stopPolling() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  load() {
    return api.coffee('getOrder', { id: this.id }).then((order) => {
      this.setData({ order, step: STEP[order.status] || 0, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  cancel() {
    wx.showModal({
      title: '取消订单',
      content: '确定不要这单了吗？',
      confirmText: '取消订单',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('cancelOrder', { id: this.id })
          .then(() => this.load())
          .catch(api.toastError)
      }
    })
  },

  payNow() {
    pay.payOrder(this.id).then((paid) => {
      if (paid) wx.showToast({ title: '付款成功', icon: 'success' })
      this.load()
    })
  },

  payByBalance() {
    pay.orderByBalance(this.id, this.data.order.payFee).then((paid) => {
      if (paid) wx.showToast({ title: '付款成功', icon: 'success' })
      this.load()
    })
  },

  backToMenu() {
    wx.switchTab({ url: '/pages/menu/menu' })
  }
})
