const api = require('../../utils/api')
const cart = require('../../utils/cart')
const table = require('../../utils/table')

Page({
  data: {
    list: [],
    total: 0,
    count: 0,
    tableNo: '',
    mode: 'dine_in',
    remark: '',
    submitting: false
  },

  onLoad() {
    this.setData({ tableNo: table.get() })
    this.refresh(cart.load())
    // 进来时再对一次菜单，价格或库存变了先告诉顾客
    api.coffee('getMenu').then(({ products }) => {
      const synced = cart.syncWithMenu(cart.load(), products)
      if (!synced.changed) return
      cart.save(synced.list)
      this.refresh(synced.list)
      wx.showModal({ title: '菜单有更新', content: '部分商品的价格或库存变了，已按最新的为你更新。', showCancel: false })
    }).catch(() => {})
  },

  refresh(list) {
    if (!list.length) {
      wx.navigateBack()
      return
    }
    const { count, total } = cart.summary(list)
    this.setData({ list, count, total })
  },

  pickMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    if (this.data.submitting) return
    const { list, mode, tableNo, remark } = this.data
    this.setData({ submitting: true })
    api.coffee('createOrder', {
      items: list.map((i) => ({ productId: i.productId, qty: i.qty, specs: i.specs })),
      mode,
      tableNo: mode === 'dine_in' ? tableNo : '',
      remark
    }).then(({ id }) => {
      cart.clear()
      wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + id })
    }).catch((err) => {
      this.setData({ submitting: false })
      if (err.code === 'TABLE_INVALID') {
        table.clear()
        this.setData({ tableNo: '' })
      }
      if (err.code === 'MENU_CHANGED' || err.code === 'TABLE_INVALID') {
        wx.showModal({ title: '没能下单', content: err.message, showCancel: false })
        return
      }
      api.toastError(err)
    })
  }
})
