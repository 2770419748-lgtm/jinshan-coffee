const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const { fenToText, textToFen } = require('../../../utils/money')

Page({
  data: {
    ready: false,
    id: '',
    claimed: 0,
    titleHint: '不填自动起名，比如「满30减5」',
    form: { amountText: '', minText: '', title: '', validDays: '7', total: '', perUser: 1, enabled: true },
    saving: false
  },

  onLoad(options) {
    this.options = options
    guard.loadStaff(['owner']).then((staff) => {
      if (!staff) return
      this.init()
    })
  },

  init() {
    const { id } = this.options
    wx.setNavigationBarTitle({ title: id ? '编辑代金券' : '新增代金券' })
    if (!id) {
      this.setData({ ready: true })
      return
    }
    api.coffee('adminListCoupons').then((coupons) => {
      const c = coupons.find((x) => x._id === id)
      if (!c) {
        wx.showToast({ title: '这张券不存在了', icon: 'none' })
        return
      }
      this.setData({
        ready: true,
        id: c._id,
        claimed: c.claimed || 0,
        form: {
          amountText: fenToText(c.amount),
          minText: c.minSpend ? fenToText(c.minSpend) : '',
          title: c.title,
          validDays: String(c.validDays),
          total: c.total ? String(c.total) : '',
          perUser: c.perUser || 1,
          enabled: c.enabled !== false
        }
      })
    }).catch(api.toastError)
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value })
  },

  changePerUser(e) {
    const perUser = Math.max(1, Math.min(10, this.data.form.perUser + Number(e.currentTarget.dataset.delta)))
    this.setData({ 'form.perUser': perUser })
  },

  buildCoupon() {
    const { form, id } = this.data
    const amount = textToFen(form.amountText)
    if (!amount) return '请填写减多少钱，比如 5'
    const minSpend = textToFen(form.minText)
    if (minSpend === null) return '「满多少可用」填错了'
    if (minSpend && minSpend < amount) return '门槛不能低于减免金额'
    const validDays = Number(form.validDays)
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) return '有效天数请填 1 到 365'
    const total = form.total === '' ? 0 : Number(form.total)
    if (!Number.isInteger(total) || total < 0) return '发放总数填错了，不限量就空着'
    const coupon = { amount, minSpend, title: form.title.trim(), validDays, total, perUser: form.perUser, enabled: form.enabled }
    if (id) coupon._id = id
    return coupon
  },

  save() {
    if (this.data.saving) return
    const coupon = this.buildCoupon()
    if (typeof coupon === 'string') {
      wx.showToast({ title: coupon, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.coffee('saveCoupon', { coupon }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除代金券',
      content: '删除后顾客领不到了，已经领的照样能用。只是暂停的话，关掉「发放」就好。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('deleteCoupon', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch(api.toastError)
      }
    })
  }
})
