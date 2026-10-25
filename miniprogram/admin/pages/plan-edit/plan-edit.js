const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const { fenToText, textToFen } = require('../../../utils/money')

Page({
  data: {
    ready: false,
    id: '',
    form: { priceText: '', bonusText: '', memberDays: '365', title: '', desc: '', enabled: true },
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
    wx.setNavigationBarTitle({ title: id ? '编辑充值档位' : '新增充值档位' })
    if (!id) {
      this.setData({ ready: true })
      return
    }
    api.member('getMemberSettings').then(({ plans }) => {
      const p = plans.find((x) => x._id === id)
      if (!p) {
        wx.showToast({ title: '这个档位不存在了', icon: 'none' })
        return
      }
      this.setData({
        ready: true,
        id: p._id,
        form: {
          priceText: fenToText(p.price),
          bonusText: p.bonus ? fenToText(p.bonus) : '',
          memberDays: p.memberDays ? String(p.memberDays) : '',
          title: p.title,
          desc: p.desc || '',
          enabled: p.enabled !== false
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

  buildPlan() {
    const { form, id } = this.data
    const price = textToFen(form.priceText)
    if (!price) return '请填写充值金额，比如 300'
    const bonus = textToFen(form.bonusText)
    if (bonus === null) return '赠送金额填错了，不送就空着'
    const memberDays = form.memberDays === '' ? 0 : Number(form.memberDays)
    if (!Number.isInteger(memberDays) || memberDays < 0 || memberDays > 3650) return '会员天数请填 0 到 3650，不送就空着'
    const plan = { price, bonus, memberDays, title: form.title.trim(), desc: form.desc.trim(), enabled: form.enabled }
    if (id) plan._id = id
    return plan
  },

  save() {
    if (this.data.saving) return
    const plan = this.buildPlan()
    if (typeof plan === 'string') {
      wx.showToast({ title: plan, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.member('savePlan', { plan }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除档位',
      content: '删除后顾客不能再充这一档，已经充进去的钱不受影响。只是暂停的话，关掉「上架」就好。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.member('deletePlan', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch(api.toastError)
      }
    })
  }
})
