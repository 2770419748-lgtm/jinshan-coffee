const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const { fenToText, textToFen } = require('../../../utils/money')

Page({
  data: {
    ready: false,
    id: '',
    products: [], // 咖啡菜单里的商品，用来选赠饮范围
    picked: {}, // 选中的赠饮商品 id
    form: {
      name: '',
      type: 'hourly',
      priceText: '',
      minHours: '1',
      maxHours: '8',
      graceMinutes: '10',
      freeCups: 0,
      freeMaxText: '',
      desc: '',
      sort: 0,
      onShelf: true
    },
    saving: false
  },

  onLoad(options) {
    this.options = options
    guard.loadStaff(guard.BOOK_ROLES).then((staff) => {
      if (!staff) return
      this.init()
    })
  },

  init() {
    const { id } = this.options
    wx.setNavigationBarTitle({ title: id ? '编辑规则' : '新增规则' })
    const jobs = [api.coffee('getMenu').catch(() => ({ products: [] }))]
    if (id) jobs.push(api.book('getRule', { id }))
    Promise.all(jobs).then(([menu, rule]) => {
      const data = { ready: true, products: menu.products.map((p) => ({ _id: p._id, name: p.name })) }
      if (rule) {
        data.id = rule._id
        data.form = {
          name: rule.name,
          type: rule.type,
          priceText: fenToText(rule.price),
          minHours: String(rule.minHours || 1),
          maxHours: String(rule.maxHours || 8),
          graceMinutes: String(rule.graceMinutes === undefined ? 10 : rule.graceMinutes),
          freeCups: rule.freeCups || 0,
          freeMaxText: rule.freeMaxFee ? fenToText(rule.freeMaxFee) : '',
          desc: rule.desc || '',
          sort: rule.sort || 0,
          onShelf: rule.onShelf !== false
        }
        const picked = {}
        ;(rule.freeProducts || []).forEach((p) => { picked[p.id] = true })
        data.picked = picked
        // 已经下架、不在菜单里的赠饮商品也留着，免得保存时丢掉
        ;(rule.freeProducts || []).forEach((p) => {
          if (!data.products.some((x) => x._id === p.id)) data.products.push({ _id: p.id, name: p.name + '（已下架）' })
        })
      }
      this.setData(data)
    }).catch(api.toastError)
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onShelf(e) {
    this.setData({ 'form.onShelf': e.detail.value })
  },

  pickType(e) {
    this.setData({ 'form.type': e.currentTarget.dataset.type })
  },

  changeCups(e) {
    const freeCups = Math.max(0, Math.min(5, this.data.form.freeCups + Number(e.currentTarget.dataset.delta)))
    this.setData({ 'form.freeCups': freeCups })
  },

  toggleProduct(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ ['picked.' + id]: !this.data.picked[id] })
  },

  buildRule() {
    const { form, id, products, picked } = this.data
    if (!form.name.trim()) return '请填写规则名称'
    const price = textToFen(form.priceText)
    if (price === null || form.priceText === '') return '请填写正确的价格，比如 8 或 8.5'
    const rule = {
      name: form.name.trim(),
      type: form.type,
      price,
      desc: form.desc.trim(),
      sort: Number(form.sort) || 0,
      onShelf: form.onShelf
    }
    if (form.type === 'hourly') {
      if (!price) return '每小时价格不能是 0'
      rule.minHours = Number(form.minHours)
      rule.maxHours = Number(form.maxHours)
      rule.graceMinutes = Number(form.graceMinutes || 0)
      if (!Number.isInteger(rule.minHours) || rule.minHours < 1) return '最少小时数至少 1'
      if (!Number.isInteger(rule.maxHours) || rule.maxHours < rule.minHours || rule.maxHours > 24) return '最多小时数要在最少小时数到 24 之间'
      if (!Number.isInteger(rule.graceMinutes) || rule.graceMinutes > 60) return '宽限时间请填 0 到 60 分钟'
    } else {
      rule.freeCups = form.freeCups
      const maxFee = textToFen(form.freeMaxText)
      if (maxFee === null) return '每杯最多抵扣的金额填错了'
      rule.freeMaxFee = maxFee
      // 菜单商品的显示名里可能带「（已下架）」，存原名
      rule.freeProducts = products.filter((p) => picked[p._id]).map((p) => ({ id: p._id, name: p.name.replace(/（已下架）$/, '') }))
    }
    if (id) rule._id = id
    return rule
  },

  save() {
    if (this.data.saving) return
    const rule = this.buildRule()
    if (typeof rule === 'string') {
      wx.showToast({ title: rule, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.book('saveRule', { rule }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除规则',
      content: '已经下的单不受影响。只是暂时不用的话，关掉「上架」就好。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.book('deleteRule', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch(api.toastError)
      }
    })
  }
})
