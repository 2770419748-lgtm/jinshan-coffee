// 业务代码（functions/ 里）用到的底层能力都从这里拿：数据库、当前用户是谁、小程序码、微信支付、图片存储。
// 原来这些由微信云开发提供（wx-server-sdk），现在换成自己服务器上的实现，接口保持一样，业务代码基本不用改。
// 启动时先 configure() 装好各部分，再加载 functions/ 里的模块。
const { AsyncLocalStorage } = require('async_hooks')

const context = new AsyncLocalStorage()
const parts = { db: null, wechat: null, pay: null, storage: null }

function need(name) {
  if (!parts[name]) throw new Error('platform.' + name + ' is not configured')
  return parts[name]
}

module.exports = {
  configure(options) {
    Object.keys(options).forEach((k) => {
      if (!(k in parts)) throw new Error('unknown platform part ' + k)
      parts[k] = options[k]
    })
  },

  database() {
    return need('db')
  },

  // 当前请求是哪位微信用户（小程序登录后的 openid）；电脑网页后台的请求这里是空的，靠 webToken 识别
  getWXContext() {
    const store = context.getStore()
    return { OPENID: (store && store.openid) || '' }
  },

  runAs(openid, fn) {
    return context.run({ openid: openid || '' }, fn)
  },

  openapi: {
    wxacode: {
      getUnlimited: (params) => need('wechat').getUnlimited(params)
    }
  },

  // 微信支付（见 lib/wxpay.js）；没配置商户号时 ready() 是 false
  get pay() {
    return need('pay')
  },

  // 存一张图片，返回 { fileID }，fileID 是 /uploads/ 开头的地址
  uploadFile: (params) => need('storage').upload(params),
  deleteFile: (params) => need('storage').remove(params)
}
