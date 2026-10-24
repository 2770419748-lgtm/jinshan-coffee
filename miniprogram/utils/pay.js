// 微信支付：先让云函数下单拿到支付参数，再拉起微信支付；付完向云端确认一次
const api = require('./api')

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

// 返回 true 表示付成功了；false 表示顾客取消了或者还没确认到
function run(fn, action, data, field) {
  wx.showLoading({ title: '正在发起支付', mask: true })
  return api[fn](action, data).then(({ payment }) => {
    wx.hideLoading()
    return requestPayment(payment)
  }).then((done) => {
    if (!done) return false
    wx.showLoading({ title: '确认付款中', mask: true })
    return confirm(fn, { id: data.id, kind: data.kind }, field).then((paid) => {
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

module.exports = {
  payOrder: (id) => run('coffee', 'payOrder', { id }, 'payStatus'),
  payRental: (id) => run('book', 'payRental', { id }, 'payStatus'),
  payOvertime: (id) => run('book', 'payRental', { id, kind: 'overtime' }, 'overtimePayStatus')
}
