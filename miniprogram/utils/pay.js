// 微信支付：先让服务器下单拿到支付参数，再拉起微信支付；付完向服务器确认一次。会员余额付款也在这里
const api = require('./api')
const { fenToText } = require('./money')

function requestPayment(payment) {
  return new Promise((resolve, reject) => {
    wx.requestPayment(Object.assign({}, payment, {
      success: () => resolve(true),
      fail: (err) => {
        // 顾客自己关掉支付窗口不算出错
        if (err && /cancel/i.test(err.errMsg || '')) resolve(false)
        else reject(err)
      }
    }))
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 回调可能比顾客端慢一点，查几次
function confirm(fn, data, field) {
  let tries = 0
  const once = () => api[fn]('confirmPay', data).then((res) => {
    if (res[field] === 'paid' || ++tries >= 3) return res[field] === 'paid'
    return wait(1500).then(once)
  })
  return once()
}

// 返回 true 表示付成功了；false 表示顾客取消了或者还没确认到。
// 服务器返回 { payment }，在线充值时还带 id（充值单是这时才建的）
function run(fn, action, data, field) {
  let id = data.id
  wx.showLoading({ title: '正在发起支付', mask: true })
  return api[fn](action, data).then((res) => {
    wx.hideLoading()
    if (res.id) id = res.id
    return requestPayment(res.payment)
  }).then((done) => {
    if (!done) return false
    wx.showLoading({ title: '确认付款中', mask: true })
    return confirm(fn, { id, kind: data.kind }, field).then((paid) => {
      wx.hideLoading()
      return paid
    })
  }).catch((err) => {
    wx.hideLoading()
    if (err && !err.code && /requestPayment/.test(err.errMsg || '')) wx.showToast({ title: '支付没成功，可以再试一次', icon: 'none' })
    else api.toastError(err)
    return false
  })
}

// 用会员余额付：先让顾客确认一下金额，返回 true 表示付好了
function balance(fn, action, data, amount) {
  return new Promise((resolve) => {
    wx.showModal({
      title: '用余额付款',
      content: '从会员余额里扣 ¥' + fenToText(amount) + '，确定吗？',
      confirmText: '确定付款',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false)
    })
  }).then((ok) => {
    if (!ok) return false
    wx.showLoading({ title: '付款中', mask: true })
    return api[fn](action, data).then(() => {
      wx.hideLoading()
      return true
    })
  }).catch((err) => {
    wx.hideLoading()
    api.toastError(err)
    return false
  })
}

module.exports = {
  payOrder: (id) => run('coffee', 'payOrder', { id }, 'payStatus'),
  payRental: (id) => run('book', 'payRental', { id }, 'payStatus'),
  payOvertime: (id) => run('book', 'payRental', { id, kind: 'overtime' }, 'overtimePayStatus'),
  payRecharge: (planId) => run('member', 'createRecharge', { planId }, 'payStatus'),
  orderByBalance: (id, amount) => balance('coffee', 'payWithBalance', { id }, amount),
  rentalByBalance: (id, amount) => balance('book', 'payRentalWithBalance', { id }, amount),
  overtimeByBalance: (id, amount) => balance('book', 'payRentalWithBalance', { id, kind: 'overtime' }, amount)
}
