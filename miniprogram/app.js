const table = require('./utils/table')

App({
  globalData: {
    ordersTab: '', // 让「订单」页打开时切到哪个标签
    focusProduct: '', // 首页轮播点了某个商品，点单页打开时跳到它
    pickedAddress: null // 外送：在地址页选好的收货地址，结算页拿走
  },

  // 扫桌码打开时 query 里带着 scene=t%3D桌号；冷启动和从后台切回来都会走这里
  onShow(options) {
    const tableNo = table.parseQuery(options && options.query)
    if (tableNo) table.set(tableNo)
  }
})
