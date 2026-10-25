// 微信支付（直连商户号，API v3）：咖啡和借书共用。
// 商户号、API 证书、APIv3 密钥填在服务器的配置文件里（见 README），店主在后台「店铺设置」里只管开关。
// 支付成功后微信会通知服务器 /pay/notify/<模块名>，通知里再向微信查一次单、核对金额，才标成已付。
const cloud = require('../platform')
const { BizError, isMissingCollection } = require('./base')

const DEFAULTS = { payEnabled: false, allowCounter: true }

function payReady() {
  return cloud.pay.ready()
}

async function getSettings(db) {
  let saved = {}
  try {
    const res = await db.collection('settings').where({ _id: 'shop' }).limit(1).get()
    saved = res.data[0] || {}
  } catch (e) {
    if (!isMissingCollection(e)) throw e
  }
  const s = Object.assign({}, DEFAULTS, saved)
  return { payEnabled: !!(s.payEnabled && payReady()), allowCounter: s.allowCounter !== false }
}

// 给顾客端看的：能不能微信支付、还能不能到吧台付
function publicPay(settings) {
  return { enabled: settings.payEnabled, allowCounter: !settings.payEnabled || settings.allowCounter }
}

// 下单，返回给 wx.requestPayment 用的参数；openid 是付款的顾客
async function unifiedOrder(settings, { body, outTradeNo, totalFee, openid, notify }) {
  if (!settings.payEnabled) throw new BizError('店里还没开通微信支付，请到吧台付款', 'PAY_DISABLED')
  if (!Number.isInteger(totalFee) || totalFee <= 0) throw new BizError('金额不对')
  if (!openid) throw new BizError('请在微信里打开小程序付款')
  try {
    return await cloud.pay.jsapi({
      description: Array.from(body).slice(0, 40).join(''),
      outTradeNo,
      total: totalFee,
      openid,
      notifyPath: '/pay/notify/' + notify
    })
  } catch (e) {
    console.error('wxpay jsapi failed', outTradeNo, e)
    throw new BizError('发起微信支付失败：' + (e.wxMessage || '请稍后再试'))
  }
}

// 向微信查单：真的付了才返回 { transactionId, totalFee }，否则返回 null
async function queryPaid(outTradeNo) {
  if (!payReady() || !outTradeNo) return null
  try {
    const res = await cloud.pay.query(outTradeNo)
    if (res && res.tradeState === 'SUCCESS') return { transactionId: res.transactionId || '', totalFee: Number(res.total) }
  } catch (e) {
    console.error('wxpay query failed', outTradeNo, e)
  }
  return null
}

// 原路退款；refundFee 默认全额。微信受理了（处理中或已成功）就算退了
async function refund({ outTradeNo, outRefundNo, totalFee, refundFee }) {
  if (!payReady()) throw new BizError('服务器上没有配置微信支付，退不了款')
  let res
  try {
    res = await cloud.pay.refund({ outTradeNo, outRefundNo, total: totalFee, refund: refundFee || totalFee })
  } catch (e) {
    console.error('wxpay refund failed', outTradeNo, e)
    throw new BizError('微信退款失败：' + (e.wxMessage || '请稍后再试'))
  }
  if (!res || (res.status !== 'SUCCESS' && res.status !== 'PROCESSING')) {
    console.error('wxpay refund result', outTradeNo, res)
    throw new BizError('微信退款失败：' + ((res && res.status) || '请稍后再试'))
  }
  return true
}

module.exports = { payReady, getSettings, publicPay, unifiedOrder, queryPaid, refund }
