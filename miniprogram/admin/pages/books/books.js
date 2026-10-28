const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    loading: true,
    keyword: '',
    all: [],
    list: []
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
    return api.book('adminListBooks').then((all) => {
      this.setData({ all, loading: false })
      this.filter()
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  filter() {
    const kw = this.data.keyword.trim().toLowerCase()
    const list = !kw ? this.data.all : this.data.all.filter((b) =>
      [b.title, b.author, b.isbn, b.category].some((v) => String(v || '').toLowerCase().indexOf(kw) !== -1))
    this.setData({ list })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.filter()
  },

  toggleShelf(e) {
    const id = e.currentTarget.dataset.id
    const onShelf = e.detail.value
    const patch = (value) => {
      this.setData({ all: this.data.all.map((b) => (b._id === id ? Object.assign({}, b, { onShelf: value }) : b)) })
      this.filter()
    }
    patch(onShelf)
    api.book('setBookFlags', { id, onShelf }).catch((err) => {
      api.toastError(err)
      patch(!onShelf)
    })
  },

  edit(e) {
    wx.navigateTo({ url: '/admin/pages/book-edit/book-edit?id=' + e.currentTarget.dataset.id })
  },

  add() {
    wx.navigateTo({ url: '/admin/pages/book-edit/book-edit' })
  },

  seedDemo() {
    wx.showModal({
      title: '导入示例',
      content: '会导入 3 本示例书和 2 条计费规则（按小时、包天送咖啡），导入后请改成店里真实的书和价格。',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '导入中', mask: true })
        api.book('seedDemo').then(() => {
          wx.hideLoading()
          wx.showToast({ title: '已导入', icon: 'success' })
          this.load()
        }).catch((err) => {
          wx.hideLoading()
          api.toastError(err)
        })
      }
    })
  },

  noop() {}
})
