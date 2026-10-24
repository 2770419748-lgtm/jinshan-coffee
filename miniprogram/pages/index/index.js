const api = require('../../utils/api')
const table = require('../../utils/table')

Page({
  data: {
    tableNo: '',
    activeOrder: null
  },

  onShow() {
    this.setData({ tableNo: table.get() })
    this.loadActiveOrder()
  },

  // 首页提示今天还没取的订单
  loadActiveOrder() {
    api.coffee('myOrders', { page: 0 }).then(({ orders }) => {
      const active = orders.find((o) => o.status === 'pending' || o.status === 'making')
      this.setData({ activeOrder: active || null })
    }).catch(() => {})
  },

  scan() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['wxCode', 'qrCode'],
      success: (res) => {
        const tableNo = table.parsePath(res.path)
        if (!tableNo) {
          wx.showToast({ title: '这不是本店的桌码', icon: 'none' })
          return
        }
        table.set(tableNo)
        wx.switchTab({ url: '/pages/menu/menu' })
      }
    })
  },

  goMenu() {
    wx.switchTab({ url: '/pages/menu/menu' })
  },

  openOrder() {
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + this.data.activeOrder._id })
  },

  onShareAppMessage() {
    return { title: '进山咖啡', path: '/pages/index/index' }
  }
})
