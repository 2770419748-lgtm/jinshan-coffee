const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

const KIND_LIST = [
  { key: 'product', name: '商品' },
  { key: 'book', name: '书' },
  { key: 'coupons', name: '领券中心' },
  { key: 'none', name: '只放图片' }
]
const HINTS = {
  product: ['不填用商品名', '不填显示「新品上市」'],
  book: ['不填用书名', '不填显示「新书上架」'],
  coupons: ['不填显示「领券中心」', '不填显示「代金券限时领取」'],
  none: ['选填', '选填']
}

Page({
  data: {
    ready: false,
    id: '',
    kindList: KIND_LIST,
    options: { products: [], books: [] },
    targets: [],
    targetIndex: -1,
    fallbackImage: '',
    titleHint: HINTS.product[0],
    subtitleHint: HINTS.product[1],
    form: { kind: 'product', targetId: '', image: '', title: '', subtitle: '', enabled: true },
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
    wx.setNavigationBarTitle({ title: id ? '编辑轮播' : '新增轮播' })
    const jobs = [api.common('bannerOptions'), id ? api.common('listBanners') : Promise.resolve([])]
    Promise.all(jobs).then(([options, banners]) => {
      const data = { ready: true, options }
      const banner = id && banners.find((b) => b._id === id)
      if (id && !banner) {
        wx.showToast({ title: '这张轮播不存在了', icon: 'none' })
        return
      }
      if (banner) {
        data.id = banner._id
        data.form = { kind: banner.kind, targetId: banner.targetId || '', image: banner.image || '', title: banner.title || '', subtitle: banner.subtitle || '', enabled: banner.enabled !== false }
        // 指向的商品或书已经下架了，也放进列表，免得保存时丢掉
        const list = banner.kind === 'book' ? options.books : options.products
        if (banner.targetId && (banner.kind === 'product' || banner.kind === 'book') && !list.some((x) => x._id === banner.targetId)) {
          list.push({ _id: banner.targetId, name: (banner.targetName || '原来选的') + '（已下架）', image: '' })
        }
      }
      this.setData(data)
      this.refreshTargets()
    }).catch(api.toastError)
  },

  refreshTargets() {
    const { form, options } = this.data
    const targets = form.kind === 'book' ? options.books : form.kind === 'product' ? options.products : []
    const targetIndex = targets.findIndex((t) => t._id === form.targetId)
    const hints = HINTS[form.kind]
    this.setData({
      targets,
      targetIndex,
      fallbackImage: targetIndex >= 0 ? targets[targetIndex].image : '',
      titleHint: hints[0],
      subtitleHint: hints[1]
    })
  },

  pickKind(e) {
    const kind = e.currentTarget.dataset.kind
    if (kind === this.data.form.kind) return
    this.setData({ 'form.kind': kind, 'form.targetId': '' })
    this.refreshTargets()
  },

  pickTarget(e) {
    const target = this.data.targets[Number(e.detail.value)]
    if (!target) return
    this.setData({ 'form.targetId': target._id })
    this.refreshTargets()
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value })
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中', mask: true })
        api.upload(res.tempFiles[0].tempFilePath, 'banners').then((url) => {
          wx.hideLoading()
          this.setData({ 'form.image': url })
        }).catch((err) => {
          wx.hideLoading()
          api.toastError(err)
        })
      }
    })
  },

  removeImage() {
    this.setData({ 'form.image': '' })
  },

  save() {
    const { form, id, saving } = this.data
    if (saving) return
    if ((form.kind === 'product' || form.kind === 'book') && !form.targetId) {
      wx.showToast({ title: form.kind === 'product' ? '请选择一个商品' : '请选择一本书', icon: 'none' })
      return
    }
    if (form.kind === 'none' && !form.image) {
      wx.showToast({ title: '只放图片的轮播要上传一张图', icon: 'none' })
      return
    }
    const banner = Object.assign({}, form, { title: form.title.trim(), subtitle: form.subtitle.trim() })
    if (id) banner._id = id
    this.setData({ saving: true })
    api.common('saveBanner', { banner }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除轮播',
      content: '只是暂时不想放的话，关掉「显示」就好。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.common('deleteBanner', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch(api.toastError)
      }
    })
  }
})
