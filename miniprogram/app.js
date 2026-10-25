const table = require('./utils/table')

App({
  globalData: {
    ordersTab: '' // 让「订单」页打开时切到哪个标签
  },

  // 扫桌码打开时 query 里带着 scene=t%3D桌号；冷启动和从后台切回来都会走这里
  onShow(options) {
    const tableNo = table.parseQuery(options && options.query)
    if (tableNo) table.set(tableNo)
  }
})
