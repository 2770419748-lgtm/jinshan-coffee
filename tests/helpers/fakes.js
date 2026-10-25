// 测试用的替身：微信接口（小程序码、登录、订阅消息）、微信支付、图片存储。数据库用真的 SQLite（内存里）。
// 洗车小程序有自己的一套（carwashWechat、carwashPay），状态在 state.cw 里，和咖啡的分开记
const state = {
  files: [],
  deleted: [],
  envVersion: null,
  lastCodeParams: null,
  unreleased: false,
  payReady: true,
  payFail: false,
  payOrders: {},
  refunds: [],
  // 订阅消息：公众平台「我的模板」里的模板，发出去的消息，sendError 不为空时发送报这个错误码
  templates: [],
  sent: [],
  sendError: 0,
  cw: { payReady: true, payOrders: {}, refunds: [] }
}

const wechat = {
  ready: () => true,
  // code 直接当 openid 用，测试里方便
  async code2session(code) {
    if (code === 'bad') {
      const e = new Error('errCode: 40029 | errMsg: invalid code')
      e.errCode = 40029
      throw e
    }
    return { openid: 'OPENID_' + code }
  },
  async getUnlimited(params) {
    // 小程序没发布时，正式版又要检查页面，微信会报 41030
    if (state.unreleased && params.envVersion === 'release' && params.checkPath !== false) {
      const e = new Error('errCode: 41030 | errMsg: invalid page')
      e.errCode = 41030
      throw e
    }
    state.envVersion = params.envVersion
    state.lastCodeParams = params
    return { buffer: Buffer.from('png'), contentType: 'image/png' }
  },
  async getTemplateList() {
    return state.templates
  },
  async sendSubscribe(params) {
    if (state.sendError) {
      const e = new Error('errCode: ' + state.sendError + ' | errMsg: fail')
      e.errCode = state.sendError
      throw e
    }
    state.sent.push(params)
    return true
  }
}

// 测试里用 state.payOrders[outTradeNo].paid = true 假装顾客付了款（洗车的是 state.cw.payOrders）
function makePay(s, mchId) {
  return {
    get mchId() { return s.payReady ? mchId : '' },
    ready: () => s.payReady,
    async jsapi(params) {
      if (s.payFail) {
        const e = new Error('wxpay 400 PARAM_ERROR 商户号未开通 JSAPI 支付')
        e.wxMessage = '商户号未开通 JSAPI 支付'
        throw e
      }
      const prev = s.payOrders[params.outTradeNo]
      s.payOrders[params.outTradeNo] = { params, paid: prev ? prev.paid : false }
      return { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=wx' + params.outTradeNo, signType: 'RSA', paySign: 'sign' }
    },
    async query(outTradeNo) {
      const o = s.payOrders[outTradeNo]
      if (!o) return null
      return { tradeState: o.paid ? 'SUCCESS' : 'NOTPAY', transactionId: 'tx' + outTradeNo, total: o.params.total }
    },
    async refund(params) {
      s.refunds.push(params)
      return { status: 'PROCESSING', refundId: 'rf' + params.outRefundNo }
    }
  }
}

const pay = makePay(state, '1900000109')
const carwashPay = makePay(state.cw, '1900000209')

// 洗车小程序的登录：code 'U1-xxx' 表示带 unionid U1 的用户，openid 是 'CW_xxx'
const carwashWechat = {
  ready: () => true,
  async code2session(code) {
    const m = /^(U\w+)-(\w+)$/.exec(code)
    if (m) return { openid: 'CW_' + m[2], unionid: m[1] }
    return { openid: 'CW_' + code }
  }
}

const storage = {
  root: '/nonexistent',
  resolve: () => null,
  saveImage: (buf, folder) => {
    const id = '/uploads/' + (folder || 'misc') + '/test-' + state.files.length + '.jpg'
    state.files.push(id)
    return id
  },
  async upload({ cloudPath }) {
    const fileID = '/uploads/' + cloudPath
    state.files.push(fileID)
    return { fileID }
  },
  async remove({ fileList }) {
    state.deleted.push.apply(state.deleted, fileList)
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  }
}

module.exports = { state, wechat, pay, storage, carwashPay, carwashWechat }
