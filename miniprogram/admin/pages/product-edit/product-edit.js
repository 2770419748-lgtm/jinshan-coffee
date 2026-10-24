const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

// 常用规格，一键加入
const PRESETS = [
  { name: '杯型', options: [{ name: '中杯', priceText: '0' }, { name: '大杯', priceText: '3' }] },
  { name: '温度', options: [{ name: '热', priceText: '0' }, { name: '冰', priceText: '0' }] },
  { name: '糖度', options: [{ name: '标准糖', priceText: '0' }, { name: '少糖', priceText: '0' }, { name: '无糖', priceText: '0' }] }
]

function fenToText(fen) {
  return String((fen || 0) / 100)
}

// 元转分；填错返回 null
function textToFen(text) {
  const s = String(text === undefined ? '' : text).trim()
  if (s === '') return 0
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

Page({
  data: {
    ready: false,
    id: '',
    categories: [],
    catIndex: -1,
    presets: PRESETS,
    form: {
      name: '',
      desc: '',
      priceText: '',
      image: '',
      onShelf: true,
      sort: 0,
      specs: []
    },
    saving: false
  },

  onLoad(options) {
    this.options = options
    guard.loadStaff(guard.COFFEE_ROLES).then((staff) => {
      if (!staff) return
      this.init()
    })
  },

  init() {
    const { id, categoryId } = this.options
    wx.setNavigationBarTitle({ title: id ? '编辑商品' : '新增商品' })
    const jobs = [api.coffee('adminListProducts')]
    if (id) jobs.push(api.coffee('getProduct', { id }))
    Promise.all(jobs).then(([lists, product]) => {
      const categories = lists.categories
      const data = { ready: true, categories }
      if (product) {
        data.id = product._id
        data.form = {
          name: product.name,
          desc: product.desc || '',
          priceText: fenToText(product.price),
          image: product.image || '',
          onShelf: product.onShelf !== false,
          soldOut: !!product.soldOut,
          sort: product.sort || 0,
          specs: (product.specs || []).map((g) => ({
            name: g.name,
            options: g.options.map((o) => ({ name: o.name, priceText: fenToText(o.price) }))
          }))
        }
      }
      const catId = product ? product.categoryId : categoryId
      data.catIndex = categories.findIndex((c) => c._id === catId)
      if (data.catIndex === -1 && categories.length === 1) data.catIndex = 0
      this.setData(data)
    }).catch(api.toastError)
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onShelf(e) {
    this.setData({ 'form.onShelf': e.detail.value })
  },

  onCategory(e) {
    this.setData({ catIndex: Number(e.detail.value) })
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles[0]
        const ext = (file.tempFilePath.match(/\.(\w+)$/) || [])[1] || 'jpg'
        wx.showLoading({ title: '上传中', mask: true })
        wx.cloud.uploadFile({
          cloudPath: 'products/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext,
          filePath: file.tempFilePath
        }).then((up) => {
          wx.hideLoading()
          this.setData({ 'form.image': up.fileID })
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

  // ---------- 规格 ----------

  addPreset(e) {
    const preset = PRESETS[e.currentTarget.dataset.index]
    const specs = this.data.form.specs
    if (specs.some((g) => g.name === preset.name)) {
      wx.showToast({ title: '已经有' + preset.name + '了', icon: 'none' })
      return
    }
    this.setData({ 'form.specs': specs.concat([JSON.parse(JSON.stringify(preset))]) })
  },

  addGroup() {
    const specs = this.data.form.specs.concat([{ name: '', options: [{ name: '', priceText: '0' }] }])
    this.setData({ 'form.specs': specs })
  },

  removeGroup(e) {
    const specs = this.data.form.specs.slice()
    specs.splice(e.currentTarget.dataset.gi, 1)
    this.setData({ 'form.specs': specs })
  },

  onGroupName(e) {
    this.setData({ ['form.specs[' + e.currentTarget.dataset.gi + '].name']: e.detail.value })
  },

  addOption(e) {
    const gi = e.currentTarget.dataset.gi
    const options = this.data.form.specs[gi].options.concat([{ name: '', priceText: '0' }])
    this.setData({ ['form.specs[' + gi + '].options']: options })
  },

  removeOption(e) {
    const { gi, oi } = e.currentTarget.dataset
    const options = this.data.form.specs[gi].options.slice()
    options.splice(oi, 1)
    this.setData({ ['form.specs[' + gi + '].options']: options })
  },

  onOption(e) {
    const { gi, oi, field } = e.currentTarget.dataset
    this.setData({ ['form.specs[' + gi + '].options[' + oi + '].' + field]: e.detail.value })
  },

  // ---------- 保存 ----------

  buildProduct() {
    const { form, categories, catIndex, id } = this.data
    if (!form.name.trim()) return '请填写商品名称'
    if (catIndex < 0 || !categories[catIndex]) return '请选择分类'
    const price = textToFen(form.priceText)
    if (price === null || form.priceText === '') return '请填写正确的价格，比如 18 或 18.5'
    const specs = []
    for (let i = 0; i < form.specs.length; i++) {
      const g = form.specs[i]
      if (!g.name.trim()) return '第 ' + (i + 1) + ' 组规格没填名称'
      if (!g.options.length) return '「' + g.name + '」至少要一个选项'
      const options = []
      for (let j = 0; j < g.options.length; j++) {
        const o = g.options[j]
        const extra = textToFen(o.priceText)
        if (!o.name.trim()) return '「' + g.name + '」有选项没填名称'
        if (extra === null) return '「' + o.name + '」的加价填错了'
        options.push({ name: o.name.trim(), price: extra })
      }
      specs.push({ name: g.name.trim(), options })
    }
    const product = {
      name: form.name.trim(),
      desc: form.desc.trim(),
      categoryId: categories[catIndex]._id,
      price,
      image: form.image,
      onShelf: form.onShelf,
      soldOut: !!form.soldOut,
      sort: Number(form.sort) || 0,
      specs
    }
    if (id) product._id = id
    return product
  },

  save() {
    if (this.data.saving) return
    const product = this.buildProduct()
    if (typeof product === 'string') {
      wx.showToast({ title: product, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.coffee('saveProduct', { product }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除商品',
      content: '删除后不能恢复。只是暂时不卖的话，用“下架”就好。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('deleteProduct', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch(api.toastError)
      }
    })
  }
})
