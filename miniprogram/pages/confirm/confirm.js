const api = require('../../utils/api')
const cart = require('../../utils/cart')
const table = require('../../utils/table')
const reserve = require('../../utils/reserve')
const pay = require('../../utils/pay')
const subscribe = require('../../utils/subscribe')
const { fenToText } = require('../../utils/money')

// 这单能怎么付：微信支付（开通了才有）、会员余额（开了储值或者有余额）、到吧台付（预约不行）
function payMethods(quote, reserving) {
  const list = []
  if (quote.pay.enabled) list.push({ key: 'wechat', label: '微信支付' })
  if (quote.wallet.enabled || quote.wallet.balance > 0) list.push({ key: 'balance', label: '余额 ¥' + fenToText(quote.wallet.balance) })
  if (!reserving && quote.pay.allowCounter) list.push({ key: 'counter', label: quote.pay.enabled ? '到吧台付' : '到吧台付款' })
  return list
}

Page({
  data: {
    list: [],
    total: 0,
    count: 0,
    tableNo: '',
    mode: 'dine_in',
    remark: '',
    quote: null, // 服务器算的价 { total, vouchers, applied, voucherFee, coupons, coupon, couponFee, payFee, pay, wallet, reserve }
    useVouchers: true,
    usableCoupons: 0,
    showCoupons: false,
    reserving: false, // 预约点单：选取餐时间，必须在线付款（微信或会员余额）
    slots: [],
    slotIndex: 0,
    reserveAt: null,
    reserveLabel: '',
    payable: 0,
    methods: [], // 能选的付款方式 [{ key: wechat|balance|counter, label }]
    payMethod: 'counter',
    balanceLow: false, // 选了余额但余额不够
    submitting: false
  },

  onLoad() {
    // couponChoice：不设表示让服务器自动挑；'' 表示不用；或者某张券的 id
    this.couponChoice = undefined
    this.setData({ tableNo: table.get(), reserving: reserve.active() })
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
    if (!this.data.quote) this.setData({ payable: total })
  },

  items() {
    return this.data.list.map((i) => ({ productId: i.productId, qty: i.qty, specs: i.specs }))
  },

  // 让服务器算一遍价：赠饮券、代金券怎么抵，预约能选哪些时间
  requote() {
    if (!this.data.list.length) return
    const { useVouchers, reserving, reserveAt } = this.data
    const params = { items: this.items(), noVouchers: !useVouchers, reserve: reserving }
    if (this.couponChoice !== undefined) params.couponId = this.couponChoice
    if (reserving && reserveAt) params.reserveAt = reserveAt
    return api.coffee('quote', params).then((quote) => {
      if (reserving && !quote.reserve.enabled) {
        reserve.off()
        this.setData({ reserving: false })
        wx.showModal({ title: '预约暂未开放', content: '预约要先在线付款，店里还没开通，这单按普通点单处理。', showCancel: false })
        return this.requote()
      }
      if (reserving && !quote.reserve.slots.length) {
        wx.showModal({ title: '暂时约不了', content: '今天和明天的营业时间里都没有能约的时间了。', showCancel: false })
      }
      const data = {
        quote,
        payable: quote.payFee,
        usableCoupons: quote.coupons.filter((c) => c.discount > 0).length
      }
      if (reserving) {
        const slots = quote.reserve.slots
        data.slots = slots
        data.reserveAt = quote.reserve.reserveAt
        data.reserveLabel = quote.reserve.label
        data.slotIndex = Math.max(0, slots.findIndex((s) => s.at === quote.reserve.reserveAt))
      }
      data.methods = payMethods(quote, reserving)
      const keys = data.methods.map((m) => m.key)
      if (!this.methodPicked || keys.indexOf(this.data.payMethod) === -1) {
        // 余额够就默认用余额，否则微信，再否则到吧台
        const enough = quote.wallet.balance >= quote.payFee
        data.payMethod = keys.indexOf('balance') !== -1 && enough ? 'balance' : keys[0]
      }
      data.balanceLow = data.payMethod === 'balance' && quote.wallet.balance < quote.payFee
      this.setData(data)
    }).catch((err) => {
      this.setData({ quote: null, payable: this.data.total })
      api.toastError(err)
    })
  },

  pickPay(e) {
    const method = e.currentTarget.dataset.method
    const { quote } = this.data
    this.methodPicked = true
    this.setData({ payMethod: method, balanceLow: method === 'balance' && !!quote && quote.wallet.balance < quote.payFee })
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  toggleVouchers(e) {
    this.setData({ useVouchers: e.detail.value })
    this.requote()
  },

  pickSlot(e) {
    const slot = this.data.slots[Number(e.detail.value)]
    if (!slot) return
    this.setData({ reserveAt: slot.at, reserveLabel: slot.label, slotIndex: Number(e.detail.value) })
    this.requote()
  },

  openCoupons() {
    if (this.data.quote && this.data.quote.coupons.length) this.setData({ showCoupons: true })
  },

  closeCoupons() {
    this.setData({ showCoupons: false })
  },

  pickCoupon(e) {
    const { id, ok } = e.currentTarget.dataset
    if (id && !ok) {
      wx.showToast({ title: '这单还不满足这张券的条件', icon: 'none' })
      return
    }
    this.couponChoice = id || ''
    this.setData({ showCoupons: false })
    this.requote()
  },

  pickMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    if (this.data.submitting) return
    const { mode, tableNo, remark, quote, useVouchers, payMethod, payable, reserving, reserveAt } = this.data
    if (!quote) {
      wx.showToast({ title: '正在算价，请稍等', icon: 'none' })
      return
    }
    if (reserving && !reserveAt) {
      wx.showToast({ title: '请选择取餐时间', icon: 'none' })
      return
    }
    const byBalance = payMethod === 'balance' && payable > 0
    if (byBalance && quote.wallet.balance < payable) {
      wx.showModal({ title: '余额不够', content: '余额 ¥' + fenToText(quote.wallet.balance) + '，这单要 ¥' + fenToText(payable) + '。先去充值，或者换个付款方式。', showCancel: false })
      return
    }
    const params = {
      items: this.items(),
      mode,
      tableNo: !reserving && mode === 'dine_in' ? tableNo : '',
      remark,
      voucherIds: useVouchers ? quote.applied.map((a) => a.id) : [],
      couponId: quote.coupon ? quote.coupon.id : ''
    }
    if (reserving) params.reserveAt = reserveAt
    if (byBalance) params.payBy = 'balance'
    this.setData({ submitting: true })
    // 先问顾客要不要出餐通知（必须在点按钮时问），不管允不允许都接着下单
    subscribe.ask(quote.notifyTemplate).then((subscribed) => {
      params.subscribed = subscribed
      return api.coffee('createOrder', params)
    }).then(({ id }) => {
      cart.clear()
      if (reserving) reserve.off()
      const go = () => wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + id })
      // 选了微信支付就直接拉起支付；没付成也先进订单详情，在那里可以再付。余额付的下单时已经扣了
      if (payMethod === 'wechat' && payable > 0) return pay.payOrder(id).then(go)
      go()
    }).catch((err) => {
      this.setData({ submitting: false })
      if (err.code === 'TABLE_INVALID') {
        table.clear()
        this.setData({ tableNo: '' })
      }
      if (err.code === 'RESERVE_DISABLED') {
        reserve.off()
        this.setData({ reserving: false })
      }
      if (['MENU_CHANGED', 'TABLE_INVALID', 'VOUCHER_CHANGED', 'RESERVE_SLOT', 'RESERVE_DISABLED', 'BALANCE_LOW'].indexOf(err.code) !== -1) {
        wx.showModal({ title: '没能下单', content: err.message, showCancel: false })
        if (err.code !== 'MENU_CHANGED' && err.code !== 'TABLE_INVALID') {
          if (err.code === 'VOUCHER_CHANGED') this.couponChoice = undefined
          this.requote()
        }
        return
      }
      api.toastError(err)
    })
  }
})
