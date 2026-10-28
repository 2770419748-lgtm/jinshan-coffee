const api = require('../../utils/api')
const pay = require('../../utils/pay')

const CAR_KEY = 'carwash_car'
const PHONE_RE = /^1\d{10}$/

Page({
  data: {
    serviceId: '',
    service: null,
    modes: [],
    mode: 'store',
    days: [],
    dayIndex: 0,
    slotStart: 0,
    addresses: [],
    address: null,
    cards: [],
    cardId: '',
    wallet: { enabled: false, balance: 0 },
    pay: { wechat: false, later: false },
    payBy: '',
    unitPrice: 0,
    door: null,
    policy: [],
    notice: '',
    quote: null,
    quoteError: '',
    plate: '',
    carModel: '',
    contactName: '',
    contactPhone: '',
    remark: '',
    submitting: false,
    error: ''
  },

  onLoad(options) {
    // 上次填的车牌、车型、联系方式
    const car = wx.getStorageSync(CAR_KEY) || {}
    this.setData({ serviceId: options.id || '', plate: car.plate || '', carModel: car.carModel || '', contactName: car.contactName || '', contactPhone: car.contactPhone || '' })
    this.load()
  },

  // 从地址簿回来：用选中的地址，顺便刷新地址列表（可能刚新增了）
  onShow() {
    if (!this.loaded) return
    const picked = getApp().globalData.pickedAddress
    getApp().globalData.pickedAddress = null
    api.carwash('listAddresses').then((list) => {
      const keep = picked || this.data.address
      const address = (keep && list.find((a) => a._id === keep._id)) || list.find((a) => a.isDefault) || list[0] || null
      this.setData({ addresses: list, address })
      this.requote()
    }).catch(() => {})
  },

  load() {
    return api.carwash('getBookingInfo', { serviceId: this.data.serviceId }).then((info) => {
      this.loaded = true
      const mode = info.modes.indexOf(this.data.mode) !== -1 ? this.data.mode : info.modes[0]
      const address = this.data.address && info.addresses.find((a) => a._id === this.data.address._id)
      this.setData({
        service: info.service,
        modes: info.modes,
        mode,
        days: info.days,
        addresses: info.addresses,
        address: address || info.addresses.find((a) => a.isDefault) || info.addresses[0] || null,
        cards: info.cards,
        cardId: info.cards.length ? info.cards[0]._id : '',
        wallet: info.wallet,
        pay: info.pay,
        unitPrice: info.unitPrice,
        door: info.door,
        policy: info.policy,
        notice: info.notice,
        error: ''
      })
      if (!mode) this.setData({ error: '这个项目现在约不了' })
      this.pickFirstDay()
      this.requote()
    }).catch((err) => {
      this.setData({ error: api.errorText(err) })
    })
  },

  // 选第一个还有名额的日子；原来选的时段约满了就清掉
  pickFirstDay() {
    const { days, mode, slotStart } = this.data
    const still = slotStart && days.some((d) => d.slots.some((s) => s.start === slotStart && s.left[mode] > 0))
    if (still) return
    let dayIndex = days.findIndex((d) => d.slots.some((s) => s.left[mode] > 0))
    if (dayIndex < 0) dayIndex = 0
    this.setData({ dayIndex, slotStart: 0 })
  },

  requote() {
    const { serviceId, mode, address, cardId } = this.data
    if (!mode) return
    if (mode === 'door' && !address) {
      this.setData({ quote: null, quoteError: '' })
      return
    }
    const seq = (this.quoteSeq || 0) + 1
    this.quoteSeq = seq
    api.carwash('quote', { serviceId, mode, addressId: address ? address._id : '', cardId }).then((quote) => {
      if (seq !== this.quoteSeq) return
      this.setData({ quote, quoteError: '' })
      this.fixPayBy()
    }).catch((err) => {
      if (seq !== this.quoteSeq) return
      this.setData({ quote: null, quoteError: api.errorText(err) })
    })
  },

  // 默认付款方式：微信 → 余额够就用余额 → 到店付；原来选的还能用就不换
  fixPayBy() {
    const { quote, wallet, pay: ways, payBy } = this.data
    if (!quote || quote.payFee <= 0) return
    const ok = (by) => (by === 'wechat' && ways.wechat) || (by === 'balance' && wallet.enabled && wallet.balance >= quote.payFee) || (by === 'later' && ways.later)
    if (ok(payBy)) return
    this.setData({ payBy: ['wechat', 'balance', 'later'].find(ok) || '' })
  },

  pickMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode) return
    this.setData({ mode, quote: null })
    this.pickFirstDay()
    this.requote()
  },

  pickDay(e) {
    this.setData({ dayIndex: Number(e.currentTarget.dataset.index) })
  },

  pickSlot(e) {
    const { start, left } = e.currentTarget.dataset
    if (!left) {
      wx.showToast({ title: '这个时间约满了', icon: 'none' })
      return
    }
    this.setData({ slotStart: start })
  },

  chooseAddress() {
    wx.navigateTo({ url: '/pages/addresses/addresses?select=1' })
  },

  toggleCard(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ cardId: this.data.cardId === id ? '' : id })
    this.requote()
  },

  pickPay(e) {
    const by = e.currentTarget.dataset.by
    const { wallet, quote } = this.data
    if (by === 'balance' && !(quote && wallet.balance >= quote.payFee)) {
      wx.showToast({ title: '余额不够了，换个付款方式，或者先充值', icon: 'none' })
      return
    }
    this.setData({ payBy: by })
  },

  onPlate(e) {
    this.setData({ plate: e.detail.value.toUpperCase() })
  },

  onCarModel(e) {
    this.setData({ carModel: e.detail.value })
  },

  onName(e) {
    this.setData({ contactName: e.detail.value })
  },

  onPhone(e) {
    this.setData({ contactPhone: e.detail.value })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    const d = this.data
    if (d.submitting) return
    if (!d.slotStart) return wx.showToast({ title: '请选时间', icon: 'none' })
    if (d.mode === 'door' && !d.address) return wx.showToast({ title: '请选上门地址', icon: 'none' })
    if (!d.quote) return wx.showToast({ title: d.quoteError || '价格还没算好', icon: 'none' })
    if (d.mode === 'store' && d.contactPhone && !PHONE_RE.test(d.contactPhone)) return wx.showToast({ title: '手机号格式不对', icon: 'none' })
    const payFee = d.quote.payFee
    if (payFee > 0 && !d.payBy) return wx.showToast({ title: '请选付款方式', icon: 'none' })
    const ready = payFee > 0 && d.payBy === 'balance'
      ? new Promise((resolve) => wx.showModal({ title: '用余额付款', content: '从洗车余额里扣 ¥' + payFee / 100 + '，确定吗？', confirmText: '确定', success: (r) => resolve(r.confirm), fail: () => resolve(false) }))
      : Promise.resolve(true)
    ready.then((go) => {
      if (!go) return
      wx.setStorageSync(CAR_KEY, { plate: d.plate, carModel: d.carModel, contactName: d.contactName, contactPhone: d.contactPhone })
      this.setData({ submitting: true })
      return api.carwash('createOrder', {
        serviceId: d.serviceId,
        mode: d.mode,
        slotStart: d.slotStart,
        addressId: d.address ? d.address._id : '',
        cardId: d.cardId,
        payBy: payFee > 0 ? d.payBy : '',
        plate: d.plate,
        carModel: d.carModel,
        contactName: d.contactName,
        contactPhone: d.contactPhone,
        remark: d.remark
      }).then((res) => {
        const paid = res.awaitingPay ? pay.payOrder(res.id) : Promise.resolve(true)
        return paid.then((ok) => {
          if (!res.awaitingPay) wx.showToast({ title: '预约成功', icon: 'success' })
          else if (!ok) wx.showToast({ title: '还没付款，15 分钟内在订单里付', icon: 'none' })
          setTimeout(() => wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + res.id }), res.awaitingPay ? 300 : 800)
        })
      })
    }).catch((err) => {
      this.setData({ submitting: false })
      api.toastError(err)
      // 时段刚被别人约满、项目变了：重新拉一遍
      if (err && /SLOT_|SERVICE_GONE|CARD_GONE/.test(err.code || '')) this.load()
    })
  }
})
