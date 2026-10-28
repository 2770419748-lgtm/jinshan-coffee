const api = require('../../utils/api')
const pay = require('../../utils/pay')

const HINT = {
  pending: '等店里接单',
  confirmed: '店里已接单，到时间见',
  departed: '技师已经出发，马上到',
  serving: '正在洗',
  done: '技师说洗好了，看看满不满意，没问题点下面「确认洗好了」',
  finished: '谢谢光临',
  cancelled: '这单已经取消了'
}

Page({
  data: {
    id: '',
    order: null,
    hint: '',
    error: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.carwash('getOrder', { id: this.data.id }).then((order) => {
      let hint = HINT[order.status] || ''
      if (order.status === 'pending' && order.awaitingPay) hint = '付款后店里才能接单'
      this.setData({ order, hint, error: '' })
    }).catch((err) => this.setData({ error: api.errorText(err) }))
  },

  payWechat() {
    pay.payOrder(this.data.id).then(() => this.load())
  },

  payBalance() {
    const o = this.data.order
    if (o.payWays.balanceLeft < o.payFee) {
      wx.showToast({ title: '余额不够了，可以先去充值', icon: 'none' })
      return
    }
    pay.orderByBalance(o._id, o.payFee).then(() => this.load())
  },

  cancel() {
    const o = this.data.order
    const c = o.cancel
    const paid = o.payStatus === 'paid' && o.payFee > 0
    let content = '确定取消这次预约吗？'
    // 超时取消：用次卡的扣掉这 1 次、付的钱全退；没用次卡的扣一笔、其余退回
    if (c.late && c.fee && o.cardId) content = '离开始已经很近了，现在取消次卡这次不退' + (paid ? '，付的 ¥' + o.payFee / 100 + ' 原路退回' : '') + '。确定取消吗？'
    else if (c.late && c.fee) content = '离开始已经很近了，现在取消要扣 ¥' + Math.min(c.fee, o.payFee) / 100 + '，其余原路退回。确定取消吗？'
    else if (paid || o.cardId) content = (paid ? '付的钱' : '') + (paid && o.cardId ? '和' : '') + (o.cardId ? '次卡' : '') + '会原路退回，确定取消吗？'
    wx.showModal({
      title: '取消预约',
      content,
      confirmText: '取消预约',
      cancelText: '不取消',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '正在取消', mask: true })
        api.carwash('cancelOrder', { id: o._id }).then(() => {
          wx.hideLoading()
          wx.showToast({ title: '已取消', icon: 'success' })
          this.load()
        }).catch((err) => {
          wx.hideLoading()
          api.toastError(err)
          this.load()
        })
      }
    })
  },

  confirmDone() {
    api.carwash('confirmDone', { id: this.data.id }).then(() => {
      wx.showToast({ title: '谢谢', icon: 'success' })
      this.load()
    }).catch(api.toastError)
  },

  callShop() {
    wx.makePhoneCall({ phoneNumber: this.data.order.shop.phone, fail: () => {} })
  }
})
