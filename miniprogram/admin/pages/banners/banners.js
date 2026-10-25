const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

const KINDS = { product: '商品', book: '书', coupons: '领券中心', none: '只放图片' }

Page({
  data: {
    ready: false,
    loading: true,
    banners: [],
    kinds: KINDS
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

  load() {
    return api.common('listBanners').then((banners) => {
      this.setData({ banners, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id
    const enabled = e.detail.value
    const patch = (value) => this.setData({ banners: this.data.banners.map((b) => (b._id === id ? Object.assign({}, b, { enabled: value }) : b)) })
    patch(enabled)
    api.common('setBannerFlags', { id, enabled }).catch((err) => {
      api.toastError(err)
      patch(!enabled)
    })
  },

  move(e) {
    const index = Number(e.currentTarget.dataset.index)
    const to = index + Number(e.currentTarget.dataset.delta)
    const list = this.data.banners.slice()
    if (to < 0 || to >= list.length) return
    const [item] = list.splice(index, 1)
    list.splice(to, 0, item)
    this.setData({ banners: list })
    api.common('sortBanners', { ids: list.map((b) => b._id) }).catch((err) => {
      api.toastError(err)
      this.load()
    })
  },

  edit(e) {
    wx.navigateTo({ url: '/admin/pages/banner-edit/banner-edit?id=' + e.currentTarget.dataset.id })
  },

  add() {
    wx.navigateTo({ url: '/admin/pages/banner-edit/banner-edit' })
  },

  noop() {}
})
