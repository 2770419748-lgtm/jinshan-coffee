const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    loading: true,
    list: []
  },

  onShow() {
    guard.loadStaff(guard.COFFEE_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      this.load()
    })
  },

  load() {
    return api.coffee('adminListProducts').then(({ categories, products }) => {
      const counts = {}
      products.forEach((p) => { counts[p.categoryId] = (counts[p.categoryId] || 0) + 1 })
      const list = categories.map((c) => Object.assign({}, c, { count: counts[c._id] || 0 }))
      this.setData({ list, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  askName(title, content) {
    return new Promise((resolve) => {
      wx.showModal({
        title,
        content: content || '',
        editable: true,
        placeholderText: '分类名称，最多 10 个字',
        success: (res) => resolve(res.confirm ? String(res.content || '').trim() : null)
      })
    })
  },

  add() {
    this.askName('新建分类').then((name) => {
      if (!name) return
      api.coffee('saveCategory', { name }).then(() => this.load()).catch(api.toastError)
    })
  },

  rename(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    this.askName('修改分类名称', item.name).then((name) => {
      if (!name || name === item.name) return
      api.coffee('saveCategory', { id: item._id, name }).then(() => this.load()).catch(api.toastError)
    })
  },

  move(e) {
    const { index, delta } = e.currentTarget.dataset
    const to = index + Number(delta)
    const list = this.data.list.slice()
    if (to < 0 || to >= list.length) return
    const moved = list.splice(index, 1)[0]
    list.splice(to, 0, moved)
    this.setData({ list })
    api.coffee('sortCategories', { ids: list.map((c) => c._id) }).catch((err) => {
      api.toastError(err)
      this.load()
    })
  },

  remove(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    if (item.count) {
      wx.showToast({ title: '分类下还有商品，先移走', icon: 'none' })
      return
    }
    wx.showModal({
      title: '删除分类',
      content: '确定删除「' + item.name + '」吗？',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('deleteCategory', { id: item._id }).then(() => this.load()).catch(api.toastError)
      }
    })
  }
})
