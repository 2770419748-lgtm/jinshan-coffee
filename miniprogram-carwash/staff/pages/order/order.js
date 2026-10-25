const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

const OPEN = ['pending', 'confirmed', 'departed', 'serving', 'done']

// 下一步能点什么：到店的单没有「出发」
function nextSteps(o) {
  if (o.status === 'confirmed') return o.mode === 'door' ? [{ status: 'departed', label: '出发了' }] : [{ status: 'serving', label: '开始洗' }]
  if (o.status === 'departed') return [{ status: 'serving', label: '到了，开始洗' }]
  if (o.status === 'serving') return [{ status: 'done', label: '洗好了' }]
  return []
}

Page({
  data: {
    id: '',
    staff: null,
    order: null,
    next: [],
    canCancel: false,
    error: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    guard.loadStaff().then((staff) => {
      if (!staff) return
      this.setData({ staff })
      this.load()
    })
  },

  load() {
    return api.carwash('staffGetOrder', { id: this.data.id }).then((order) => {
      this.setData({ order, next: nextSteps(order), canCancel: OPEN.indexOf(order.status) !== -1, error: '' })
    }).catch((err) => this.setData({ error: api.errorText(err) }))
  },

  run(promise, done) {
    wx.showLoading({ title: '请稍等', mask: true })
    return promise.then(() => {
      wx.hideLoading()
      if (done) wx.showToast({ title: done, icon: 'success' })
      this.load()
    }).catch((err) => {
      wx.hideLoading()
      api.toastError(err)
      this.load()
    })
  },

  accept() {
    this.run(api.carwash('acceptOrder', { id: this.data.id }), '接到了')
  },

  advance(e) {
    this.run(api.carwash('advanceOrder', { id: this.data.id, status: e.currentTarget.dataset.status }))
  },

  collect() {
    const o = this.data.order
    wx.showModal({
      title: '登记收款',
      content: '已经收到顾客 ¥' + o.payFee / 100 + '（现金或收款码）了吗？',
      confirmText: '收到了',
      cancelText: '还没有',
      success: (res) => {
        if (res.confirm) this.run(api.carwash('collectPay', { id: o._id }), '已登记')
      }
    })
  },

  cancel() {
    wx.showModal({
      title: '取消这单',
      editable: true,
      placeholderText: '写上原因，比如顾客说不来了',
      confirmText: '确认取消',
      cancelText: '不取消',
      success: (res) => {
        if (!res.confirm) return
        const reason = String(res.content || '').trim()
        if (!reason) {
          wx.showToast({ title: '请写上原因', icon: 'none' })
          return
        }
        this.run(api.carwash('staffCancelOrder', { id: this.data.id, reason }), '已取消')
      }
    })
  },

  navigate() {
    const a = this.data.order.address
    if (!a || !a.location) return
    wx.openLocation({ latitude: a.location.lat, longitude: a.location.lng, name: a.place, address: a.detail, scale: 17 })
  },

  call() {
    wx.makePhoneCall({ phoneNumber: this.data.order.contactPhone, fail: () => {} })
  }
})
