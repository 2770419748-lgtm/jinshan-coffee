const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    loading: true,
    rules: []
  },

  onShow() {
    guard.loadStaff(guard.BOOK_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      this.load()
    })
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.book('adminListRules').then((rules) => {
      this.setData({ rules, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  toggleShelf(e) {
    const id = e.currentTarget.dataset.id
    const onShelf = e.detail.value
    const patch = (value) => this.setData({ rules: this.data.rules.map((r) => (r._id === id ? Object.assign({}, r, { onShelf: value }) : r)) })
    patch(onShelf)
    api.book('setRuleFlags', { id, onShelf }).catch((err) => {
      api.toastError(err)
      patch(!onShelf)
    })
  },

  edit(e) {
    wx.navigateTo({ url: '/admin/pages/rule-edit/rule-edit?id=' + e.currentTarget.dataset.id })
  },

  add() {
    wx.navigateTo({ url: '/admin/pages/rule-edit/rule-edit' })
  },

  noop() {}
})
