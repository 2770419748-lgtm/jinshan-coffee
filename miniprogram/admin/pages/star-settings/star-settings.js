const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const { fenToText, textToFen } = require('../../../utils/money')

// 选中的分类 id 列表 ⇄ { id: true }
function toPicked(ids) {
  const picked = {}
  ids.forEach((id) => { picked[id] = true })
  return picked
}

function pickedIds(picked, categories) {
  return categories.filter((c) => picked[c._id]).map((c) => c._id)
}

Page({
  data: {
    ready: false,
    loading: true,
    categories: [], // 咖啡菜单的分类
    form: {
      enabled: false,
      needText: '10',
      earnAll: true,
      redeemAll: true,
      maxText: '',
      validText: ''
    },
    earnPicked: {},
    redeemPicked: {},
    stats: null, // { holders, stars, earned, used }
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

  // 第一次进来才把设置填进表单，之后只刷新分类和统计，没保存的改动不丢
  load() {
    return api.coffee('getStarSettings').then(({ settings, categories, stats }) => {
      const data = { categories, stats, loading: false }
      if (!this.loaded) {
        this.loaded = true
        data.form = {
          enabled: settings.enabled,
          needText: String(settings.need),
          earnAll: settings.earnAll,
          redeemAll: settings.redeemAll,
          maxText: settings.maxFee ? fenToText(settings.maxFee) : '',
          validText: settings.validDays ? String(settings.validDays) : ''
        }
        data.earnPicked = toPicked(settings.earnCategories)
        data.redeemPicked = toPicked(settings.redeemCategories)
      }
      this.setData(data)
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  onEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value })
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  // 「全部商品」和具体分类二选一：点全部就清掉分类，点了分类就不是全部
  pickAll(e) {
    const kind = e.currentTarget.dataset.kind
    this.setData({ ['form.' + kind + 'All']: true, [kind + 'Picked']: {} })
  },

  toggleCategory(e) {
    const { kind, id } = e.currentTarget.dataset
    const picked = Object.assign({}, this.data[kind + 'Picked'])
    picked[id] = !picked[id]
    const any = Object.keys(picked).some((k) => picked[k])
    this.setData({ [kind + 'Picked']: picked, ['form.' + kind + 'All']: !any })
  },

  save() {
    if (this.data.saving) return
    const { form, categories, earnPicked, redeemPicked } = this.data
    const need = Number(form.needText)
    if (!Number.isInteger(need) || need < 1 || need > 100) {
      wx.showToast({ title: '几颗星换一杯请填 1 到 100', icon: 'none' })
      return
    }
    const maxFee = textToFen(form.maxText)
    if (maxFee === null) {
      wx.showToast({ title: '最多抵多少请填金额，比如 25', icon: 'none' })
      return
    }
    const validDays = form.validText === '' ? 0 : Number(form.validText)
    if (!Number.isInteger(validDays) || validDays < 0) {
      wx.showToast({ title: '有效天数请填整数，一直有效就空着', icon: 'none' })
      return
    }
    const settings = {
      enabled: form.enabled,
      need,
      earnAll: form.earnAll,
      earnCategories: pickedIds(earnPicked, categories),
      redeemAll: form.redeemAll,
      redeemCategories: pickedIds(redeemPicked, categories),
      maxFee,
      validDays
    }
    this.setData({ saving: true })
    api.coffee('saveStarSettings', { settings }).then(() => {
      this.setData({ saving: false })
      wx.showToast({ title: '已保存', icon: 'success' })
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  }
})
