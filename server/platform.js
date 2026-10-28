// 业务代码（functions/ 里）用到的底层能力都从这里拿：数据库、当前用户是谁、小程序码、订阅消息、微信支付、图片存储。
// 原来这些由微信云开发提供（wx-server-sdk），现在换成自己服务器上的实现，接口保持一样，业务代码基本不用改。
// 启动时先 configure() 装好各部分，再加载 functions/ 里的模块。
// 咖啡和洗车是两个小程序、两个商户号：wechat、pay 是咖啡的，carwash: { wechat, pay } 是洗车的。
const { AsyncLocalStorage } = require('async_hooks')

const context = new AsyncLocalStorage()
const parts = { db: null, wechat: null, pay: null, storage: null, carwash: null }
// 洗车小程序还没配置时用的空壳：不能登录、不能付款
const NOT_READY = {
  wechat: { ready: () => false },
  pay: { mchId: '', ready: () => false }
}

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

  // 当前请求是哪位微信用户。OPENID 是用户 id（两个小程序绑了开放平台时，同一个人在两边是同一个 id，见 lib/identity.js）；
  // APP 是从哪个小程序来的（coffee / carwash），APP_OPENID 是这个人在这个小程序里的 openid，微信支付要用它。
  // 电脑网页后台的请求这里都是空的，靠 webToken 识别
  getWXContext() {
    const store = context.getStore() || {}
    return { OPENID: store.openid || '', APP: store.app || '', APP_OPENID: store.appOpenid || '', UNIONID: store.unionid || '' }
  },

  runAs(openid, fn, extra) {
    const e = extra || {}
    return context.run({ openid: openid || '', app: e.app || '', appOpenid: e.appOpenid || '', unionid: e.unionid || '' }, fn)
  },

  openapi: {
    wxacode: {
      getUnlimited: (params) => need('wechat').getUnlimited(params)
    },
    subscribeMessage: {
      getTemplateList: () => need('wechat').getTemplateList(),
      send: (params) => need('wechat').sendSubscribe(params)
    }
  },

  // 微信支付（见 lib/wxpay.js）；没配置商户号时 ready() 是 false。这是咖啡的商户号
  get pay() {
    return need('pay')
  },

  // 按店取微信支付、微信接口：shop 是 coffee 或 carwash
  payOf(shop) {
    if (shop !== 'carwash') return need('pay')
    return (parts.carwash && parts.carwash.pay) || NOT_READY.pay
  },

  wechatOf(shop) {
    if (shop !== 'carwash') return need('wechat')
    return (parts.carwash && parts.carwash.wechat) || NOT_READY.wechat
  },

  // 存一张图片，返回 { fileID }，fileID 是 /uploads/ 开头的地址
  uploadFile: (params) => need('storage').upload(params),
  deleteFile: (params) => need('storage').remove(params)
}
