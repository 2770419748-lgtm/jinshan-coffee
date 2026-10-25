const api = require('../../utils/api')
const cart = require('../../utils/cart')
const table = require('../../utils/table')
const reserve = require('../../utils/reserve')
const pay = require('../../utils/pay')

Page({
  data: {
    list: [],
    total: 0,
    count: 0,
    tableNo: '',
    mode: 'dine_in',
    remark: '',
    quote: null, // 服务器算的价 { total, vouchers, applied, voucherFee, coupons, coupon, couponFee, payFee, pay, reserve }
    useVouchers: true,
    usableCoupons: 0,
    showCoupons: false,
    reserving: false, // 预约点单：选取餐时间，必须微信付款
    slots: [],
    slotIndex: 0,
    reserveAt: null,
    reserveLabel: '',
    payable: 0,
    payMethod: 'counter', // 开通微信支付后默认 wechat
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
        wx.showModal({ title: '预约暂未开放', content: '店里还没开通微信支付，这单按普通点单处理。', showCancel: false })
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
        data.payMethod = 'wechat'
      } else if (!this.methodPicked) {
        data.payMethod = quote.pay.enabled ? 'wechat' : 'counter'
      }
      this.setData(data)
    }).catch((err) => {
      this.setData({ quote: null, payable: this.data.total })
      api.toastError(err)
    })
  },

  pickPay(e) {
    this.methodPicked = true
    this.setData({ payMethod: e.currentTarget.dataset.method })
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
    const params = {
      items: this.items(),
      mode,
      tableNo: !reserving && mode === 'dine_in' ? tableNo : '',
      remark,
      voucherIds: useVouchers ? quote.applied.map((a) => a.id) : [],
      couponId: quote.coupon ? quote.coupon.id : ''
    }
    if (reserving) params.reserveAt = reserveAt
    this.setData({ submitting: true })
    api.coffee('createOrder', params).then(({ id }) => {
      cart.clear()
      if (reserving) reserve.off()
      const go = () => wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + id })
      // 选了微信支付（预约必须微信付）就直接拉起支付；没付成也先进订单详情，在那里可以再付
      if ((reserving || payMethod === 'wechat') && payable > 0) return pay.payOrder(id).then(go)
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
      if (['MENU_CHANGED', 'TABLE_INVALID', 'VOUCHER_CHANGED', 'RESERVE_SLOT', 'RESERVE_DISABLED'].indexOf(err.code) !== -1) {
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
