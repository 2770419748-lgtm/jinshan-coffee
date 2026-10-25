// 测试用的替身：微信接口（小程序码、登录）、微信支付、图片存储。数据库用真的 SQLite（内存里）。
const state = {
  files: [],
  deleted: [],
  envVersion: null,
  lastCodeParams: null,
  unreleased: false,
  payReady: true,
  payFail: false,
  payOrders: {},
  refunds: []
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
  }
}

// 测试里用 state.payOrders[outTradeNo].paid = true 假装顾客付了款
const pay = {
  get mchId() { return state.payReady ? '1900000109' : '' },
  ready: () => state.payReady,
  async jsapi(params) {
    if (state.payFail) {
      const e = new Error('wxpay 400 PARAM_ERROR 商户号未开通 JSAPI 支付')
      e.wxMessage = '商户号未开通 JSAPI 支付'
      throw e
    }
    const prev = state.payOrders[params.outTradeNo]
    state.payOrders[params.outTradeNo] = { params, paid: prev ? prev.paid : false }
    return { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=wx' + params.outTradeNo, signType: 'RSA', paySign: 'sign' }
  },
  async query(outTradeNo) {
    const o = state.payOrders[outTradeNo]
    if (!o) return null
    return { tradeState: o.paid ? 'SUCCESS' : 'NOTPAY', transactionId: 'tx' + outTradeNo, total: o.params.total }
  },
  async refund(params) {
    state.refunds.push(params)
    return { status: 'PROCESSING', refundId: 'rf' + params.outRefundNo }
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

module.exports = { state, wechat, pay, storage }
