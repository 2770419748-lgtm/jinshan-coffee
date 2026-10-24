const api = require('../../utils/api')

// 咖啡订单和借书记录分两个标签；别的页面想直接打开借书记录时，先设 getApp().globalData.ordersTab = 'book'
const SOURCES = {
  coffee: { fn: 'coffee', action: 'myOrders', key: 'orders' },
  book: { fn: 'book', action: 'myRentals', key: 'rentals' }
}

Page({
  data: {
    tab: 'coffee',
    list: [],
    loading: true,
    hasMore: false
  },

  onShow() {
    const app = getApp()
    const wanted = app.globalData && app.globalData.ordersTab
    if (wanted) {
      app.globalData.ordersTab = ''
      if (wanted !== this.data.tab) this.setData({ tab: wanted, list: [] })
    }
    this.reload()
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadPage(this.page + 1)
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab, list: [], hasMore: false })
    this.reload()
  },

  reload() {
    return this.loadPage(0)
  },

  loadPage(page) {
    const tab = this.data.tab
    const src = SOURCES[tab]
    this.setData({ loading: true })
    return api[src.fn](src.action, { page }).then((res) => {
      if (tab !== this.data.tab) return
      this.page = page
      const rows = res[src.key]
      this.setData({
        list: page === 0 ? rows : this.data.list.concat(rows),
        hasMore: res.hasMore,
        loading: false
      })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  open(e) {
    const id = e.currentTarget.dataset.id
    const page = this.data.tab === 'book' ? 'rental-detail' : 'order-detail'
    wx.navigateTo({ url: '/pages/' + page + '/' + page + '?id=' + id })
  }
})
