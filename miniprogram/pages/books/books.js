const api = require('../../utils/api')

Page({
  data: {
    loading: true,
    rules: [],
    categories: [],
    current: 'all',
    list: [],
    active: null // 正在借的书
  },

  onLoad() {
    this.books = []
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const shelf = api.book('getShelf').then(({ books, rules, categories }) => {
      this.books = books
      const current = this.data.current === 'all' || categories.indexOf(this.data.current) !== -1 ? this.data.current : 'all'
      this.setData({ rules, categories, current, loading: false })
      this.filter()
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
    const mine = api.book('myRentals', { page: 0 }).then(({ rentals }) => {
      const active = rentals.find((r) => r.status === 'reading') || rentals.find((r) => r.status === 'pending')
      this.setData({ active: active || null })
    }).catch(() => {})
    return Promise.all([shelf, mine])
  },

  filter() {
    const { current } = this.data
    this.setData({ list: current === 'all' ? this.books : this.books.filter((b) => b.category === current) })
  },

  pickCat(e) {
    this.setData({ current: e.currentTarget.dataset.cat })
    this.filter()
  },

  open(e) {
    wx.navigateTo({ url: '/pages/book-detail/book-detail?id=' + e.currentTarget.dataset.id })
  },

  openActive() {
    wx.navigateTo({ url: '/pages/rental-detail/rental-detail?id=' + this.data.active._id })
  },

  onShareAppMessage() {
    return { title: '进山咖啡 · 店内书架', path: '/pages/books/books' }
  }
})
