const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    loading: true,
    enabled: false,
    freeCategories: [],
    categories: [], // 书的分类，加上已经选了但现在没书的
    notice: '',
    plans: [],
    payEnabled: false,
    saving: false
  },

  onShow() {
    guard.loadStaff(['owner']).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      this.load()
    })
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 从档位编辑页回来只刷新档位，没保存的开关和分类不丢
  load() {
    return api.member('getMemberSettings').then(({ settings, plans, categories, payEnabled }) => {
      const data = { plans, payEnabled, loading: false }
      if (!this.loaded) {
        this.loaded = true
        Object.assign(data, { enabled: settings.enabled, freeCategories: settings.freeCategories, notice: settings.notice })
      }
      const all = categories.slice()
      ;(data.freeCategories || this.data.freeCategories).forEach((c) => { if (all.indexOf(c) === -1) all.push(c) })
      data.categories = all
      this.setData(data)
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  onEnabled(e) {
    this.setData({ enabled: e.detail.value })
  },

  toggleCategory(e) {
    const cat = e.currentTarget.dataset.cat
    const list = this.data.freeCategories.slice()
    const i = list.indexOf(cat)
    if (i === -1) list.push(cat)
    else list.splice(i, 1)
    this.setData({ freeCategories: list })
  },

  onNotice(e) {
    this.setData({ notice: e.detail.value })
  },

  save() {
    if (this.data.saving) return
    const { enabled, freeCategories, notice } = this.data
    this.setData({ saving: true })
    api.member('saveMemberSettings', { enabled, freeCategories, notice }).then(() => {
      this.setData({ saving: false })
      wx.showToast({ title: '已保存', icon: 'success' })
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  togglePlan(e) {
    const id = e.currentTarget.dataset.id
    const enabled = e.detail.value
    const patch = (value) => this.setData({ plans: this.data.plans.map((p) => (p._id === id ? Object.assign({}, p, { enabled: value }) : p)) })
    patch(enabled)
    api.member('setPlanFlags', { id, enabled }).catch((err) => {
      api.toastError(err)
      patch(!enabled)
    })
  },

  move(e) {
    const index = Number(e.currentTarget.dataset.index)
    const to = index + Number(e.currentTarget.dataset.delta)
    const list = this.data.plans.slice()
    if (to < 0 || to >= list.length) return
    const [item] = list.splice(index, 1)
    list.splice(to, 0, item)
    this.setData({ plans: list })
    api.member('sortPlans', { ids: list.map((p) => p._id) }).catch((err) => {
      api.toastError(err)
      this.load()
    })
  },

  editPlan(e) {
    wx.navigateTo({ url: '/admin/pages/plan-edit/plan-edit?id=' + e.currentTarget.dataset.id })
  },

  addPlan() {
    wx.navigateTo({ url: '/admin/pages/plan-edit/plan-edit' })
  },

  noop() {}
})
