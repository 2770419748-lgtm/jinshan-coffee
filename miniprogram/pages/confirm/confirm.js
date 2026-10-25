const api = require('../../utils/api')
const cart = require('../../utils/cart')
const table = require('../../utils/table')
const pay = require('../../utils/pay')

Page({
  data: {
    list: [],
    total: 0,
    count: 0,
    tableNo: '',
    mode: 'dine_in',
    remark: '',
    quote: null, // 服务器算的价和赠饮券 { total, vouchers, applied, discountFee, payFee }
    useVouchers: true,
    payable: 0,
    payMethod: 'counter', // 开通微信支付后默认 wechat
    submitting: false
  },

  onLoad() {
    this.setData({ tableNo: table.get() })
    this.refresh(cart.load())
    // 进来时再对一次菜单，价格或库存变了先告诉顾客
    api.coffee('getMenu').then(({ products }) => {
      const synced = cart.syncWithMenu(cart.load(), products)
      if (synced.changed) {
        cart.save(synced.list)
        this.refresh(synced.list)
        wx.showModal({ title: '菜单有更新', content: '部分商品的价格或库存变了，已按最新的为你更新。', showCancel: false })
      }
      this.requote()
    }).catch(() => {})
  },

  refresh(list) {
    if (!list.length) {
      wx.navigateBack()
      return
    }
    const { count, total } = cart.summary(list)
    this.setData({ list, count, total })
    this.updatePayable()
  },

  items() {
    return this.data.list.map((i) => ({ productId: i.productId, qty: i.qty, specs: i.specs }))
  },

  // 让服务器算一遍价，顺便看看有没有能用的赠饮券
  requote() {
    if (!this.data.list.length) return
    api.coffee('quote', { items: this.items() }).then((quote) => {
      const data = { quote }
      if (!this.methodPicked) data.payMethod = quote.pay.enabled ? 'wechat' : 'counter'
      this.setData(data)
      this.updatePayable()
    }).catch(() => {
      this.setData({ quote: null })
      this.updatePayable()
    })
  },

  updatePayable() {
    const { quote, useVouchers, total } = this.data
    this.setData({ payable: quote ? (useVouchers ? quote.payFee : quote.total) : total })
  },

  pickPay(e) {
    this.methodPicked = true
    this.setData({ payMethod: e.currentTarget.dataset.method })
  },

  toggleVouchers(e) {
    this.setData({ useVouchers: e.detail.value })
    this.updatePayable()
  },

  pickMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    if (this.data.submitting) return
    const { mode, tableNo, remark, quote, useVouchers, payMethod, payable } = this.data
    this.setData({ submitting: true })
    api.coffee('createOrder', {
      items: this.items(),
      mode,
      tableNo: mode === 'dine_in' ? tableNo : '',
      remark,
      voucherIds: useVouchers && quote ? quote.applied.map((a) => a.id) : []
    }).then(({ id }) => {
      cart.clear()
      const go = () => wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + id })
      // 选了微信支付就直接拉起支付；没付成也先进订单详情，在那里可以再付
      if (payMethod === 'wechat' && payable > 0) return pay.payOrder(id).then(go)
      go()
    }).catch((err) => {
      this.setData({ submitting: false })
      if (err.code === 'TABLE_INVALID') {
        table.clear()
        this.setData({ tableNo: '' })
      }
      if (err.code === 'MENU_CHANGED' || err.code === 'TABLE_INVALID' || err.code === 'VOUCHER_CHANGED') {
        wx.showModal({ title: '没能下单', content: err.message, showCancel: false })
        if (err.code === 'VOUCHER_CHANGED') this.requote()
        return
      }
      api.toastError(err)
    })
  }
})
