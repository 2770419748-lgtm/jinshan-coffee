const config = require('./config')
const table = require('./utils/table')

App({
  globalData: {
    ordersTab: '' // 让「订单」页打开时切到哪个标签
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }
    // 没填 envId 时用开发者工具里的默认环境
    const options = { traceUser: true }
    if (config.envId) options.env = config.envId
    wx.cloud.init(options)
  },

  // 扫桌码打开时 query 里带着 scene=t%3D桌号；冷启动和从后台切回来都会走这里
  onShow(options) {
    const tableNo = table.parseQuery(options && options.query)
    if (tableNo) table.set(tableNo)
  }
})
