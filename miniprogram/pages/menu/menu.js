const api = require('../../utils/api')
const cart = require('../../utils/cart')
const table = require('../../utils/table')
const reserve = require('../../utils/reserve')
const delivery = require('../../utils/delivery')

Page({
  data: {
    loading: true,
    tableNo: '',
    reserving: false,
    delivering: false, // 外送点单：结算时选收货地址
    scrollTo: '',
    focusId: '',
    categories: [],
    currentCat: '',
    visible: [],
    cartList: [],
    cartCount: 0,
    cartTotal: 0,
    showCart: false,
    spec: null // 正在选规格的商品 { product, selected: [选项下标], qty, unitPrice }
  },

  onLoad(options) {
    // 扫桌码直接打开点单页时，query 里带着桌号
    const tableNo = table.parseQuery(options)
    if (tableNo) table.set(tableNo)
    this.products = []
    this.loadMenu()
  },

  onShow() {
    this.setData({ tableNo: table.get(), reserving: reserve.active(), delivering: delivery.active() })
    this.refreshCart()
    this.applyFocus()
  },

  // 首页轮播点了某个商品：切到它的分类并滚过去
  applyFocus() {
    const app = getApp()
    const id = app.globalData.focusProduct
    if (!id || !this.products.length) return
    app.globalData.focusProduct = ''
    const product = this.findProduct(id)
    if (!product) {
      wx.showToast({ title: '这个商品暂时没有了', icon: 'none' })
      return
    }
    this.setData({ currentCat: product.categoryId, scrollTo: '', focusId: id })
    this.filter()
    wx.nextTick(() => this.setData({ scrollTo: 'p-' + id }))
    setTimeout(() => this.setData({ focusId: '' }), 1600)
  },

  stopReserve() {
    reserve.off()
    this.setData({ reserving: false })
  },

  stopDelivery() {
    delivery.off()
    this.setData({ delivering: false })
  },

  onPullDownRefresh() {
    this.loadMenu().then(() => wx.stopPullDownRefresh())
  },

  loadMenu() {
    return api.coffee('getMenu').then(({ categories, products }) => {
      this.products = products
      const keep = categories.some((c) => c._id === this.data.currentCat)
      const currentCat = keep ? this.data.currentCat : (categories[0] ? categories[0]._id : '')
      this.setData({ categories, currentCat, loading: false })
      this.filter()
      const synced = cart.syncWithMenu(cart.load(), products)
      if (synced.changed) cart.save(synced.list)
      this.refreshCart()
      this.applyFocus()
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  filter() {
    const visible = this.products.filter((p) => p.categoryId === this.data.currentCat)
    this.setData({ visible })
  },

  selectCat(e) {
    this.setData({ currentCat: e.currentTarget.dataset.id })
    this.filter()
  },

  findProduct(id) {
    return this.products.find((p) => p._id === id)
  },

  tapAdd(e) {
    const product = this.findProduct(e.currentTarget.dataset.id)
    if (!product || product.soldOut) return
    if (product.specs && product.specs.length) {
      const selected = product.specs.map(() => 0)
      this.setData({ spec: { product, selected, qty: 1, unitPrice: this.specPrice(product, selected) } })
      return
    }
    cart.add(product, [], 1)
    this.refreshCart()
  },

  // ---------- 选规格 ----------

  specPrice(product, selected) {
    return product.specs.reduce((sum, g, i) => sum + (g.options[selected[i]].price || 0), product.price)
  },

  pickOption(e) {
    const { g, o } = e.currentTarget.dataset
    const spec = this.data.spec
    const selected = spec.selected.slice()
    selected[g] = o
    this.setData({
      'spec.selected': selected,
      'spec.unitPrice': this.specPrice(spec.product, selected)
    })
  },

  changeSpecQty(e) {
    const qty = Math.max(1, Math.min(99, this.data.spec.qty + Number(e.currentTarget.dataset.delta)))
    this.setData({ 'spec.qty': qty })
  },

  confirmSpec() {
    const { product, selected, qty } = this.data.spec
    const specs = product.specs.map((g, i) => ({ name: g.name, option: g.options[selected[i]].name }))
    cart.add(product, specs, qty)
    this.setData({ spec: null })
    this.refreshCart()
  },

  closeSpec() {
    this.setData({ spec: null })
  },

  // ---------- 购物车 ----------

  refreshCart() {
    const list = cart.load()
    const { count, total } = cart.summary(list)
    this.setData({
      cartList: list,
      cartCount: count,
      cartTotal: total,
      showCart: this.data.showCart && count > 0
    })
  },

  toggleCart() {
    if (!this.data.cartCount) return
    this.setData({ showCart: !this.data.showCart })
  },

  changeQty(e) {
    const { key, delta } = e.currentTarget.dataset
    const item = this.data.cartList.find((i) => i.key === key)
    if (!item) return
    cart.setQty(key, item.qty + Number(delta))
    this.refreshCart()
  },

  clearCart() {
    cart.clear()
    this.refreshCart()
  },

  checkout() {
    if (!this.data.cartCount) return
    this.setData({ showCart: false })
    wx.navigateTo({ url: '/pages/confirm/confirm' })
  },

  clearTable() {
    wx.showModal({
      title: '取消桌号',
      content: '取消后下单不带桌号，凭取餐号到吧台取。',
      success: (res) => {
        if (!res.confirm) return
        table.clear()
        this.setData({ tableNo: '' })
      }
    })
  }
})
