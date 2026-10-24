const api = require('../../utils/api')
const cart = require('../../utils/cart')
const table = require('../../utils/table')

Page({
  data: {
    list: [],
    total: 0,
    count: 0,
    tableNo: '',
    mode: 'dine_in',
    remark: '',
    quote: null, // 云端算的价和赠饮券 { total, vouchers, applied, discountFee, payFee }
    useVouchers: true,
    payable: 0,
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

  // 让云端算一遍价，顺便看看有没有能用的赠饮券
  requote() {
    if (!this.data.list.length) return
    api.coffee('quote', { items: this.items() }).then((quote) => {
      this.setData({ quote })
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
    const { mode, tableNo, remark, quote, useVouchers } = this.data
    this.setData({ submitting: true })
    api.coffee('createOrder', {
      items: this.items(),
      mode,
      tableNo: mode === 'dine_in' ? tableNo : '',
      remark,
      voucherIds: useVouchers && quote ? quote.applied.map((a) => a.id) : []
    }).then(({ id }) => {
      cart.clear()
      wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + id })
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
