// 微信支付（云开发的 cloudPay）：咖啡和借书两个云函数各放一份，改的时候两边一起改。
// 店主在后台「店铺设置」里打开微信支付、填商户号；商户号要先在云开发控制台绑定到这个环境。
// 支付成功后微信会调用发起支付的那个云函数（functionName），回调里再向微信查一次单确认，防止有人伪造回调。
const crypto = require('crypto')
const { BizError, isMissingCollection } = require('./base')

const DEFAULTS = { payEnabled: false, mchId: '', allowCounter: true }

async function getSettings(db) {
  try {
    const res = await db.collection('settings').where({ _id: 'shop' }).limit(1).get()
    const s = Object.assign({}, DEFAULTS, res.data[0] || {})
    return { payEnabled: !!(s.payEnabled && s.mchId), mchId: s.mchId || '', allowCounter: s.allowCounter !== false }
  } catch (e) {
    if (isMissingCollection(e)) return Object.assign({}, DEFAULTS)
    throw e
  }
}

// 给顾客端看的：能不能微信支付、还能不能到吧台付
function publicPay(settings) {
  return { enabled: settings.payEnabled, allowCounter: !settings.payEnabled || settings.allowCounter }
}

function nonce() {
  return crypto.randomBytes(16).toString('hex')
}

function envOf(cloud) {
  return cloud.getWXContext().ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE
}

// 统一下单，返回给 wx.requestPayment 用的参数
async function unifiedOrder(cloud, settings, { body, outTradeNo, totalFee, functionName }) {
  if (!settings.payEnabled) throw new BizError('店里还没开通微信支付，请到吧台付款', 'PAY_DISABLED')
  if (!Number.isInteger(totalFee) || totalFee <= 0) throw new BizError('金额不对')
  let res
  try {
    res = await cloud.cloudPay.unifiedOrder({
      body: body.slice(0, 40),
      outTradeNo,
      spbillCreateIp: '127.0.0.1',
      subMchId: settings.mchId,
      totalFee,
      envId: envOf(cloud),
      functionName,
      nonceStr: nonce(),
      tradeType: 'JSAPI'
    })
  } catch (e) {
    console.error('unifiedOrder failed', e)
    throw new BizError('发起微信支付失败：' + (e.errMsg || e.message || '请稍后再试'))
  }
  if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS' || !res.payment) {
    console.error('unifiedOrder result', res)
    throw new BizError('发起微信支付失败：' + (res.errCodeDes || res.returnMsg || '请稍后再试'))
  }
  return res.payment
}

// 向微信查单：真的付了才返回 { transactionId, totalFee }，否则返回 null
async function queryPaid(cloud, settings, outTradeNo) {
  if (!settings.mchId || !outTradeNo) return null
  try {
    const res = await cloud.cloudPay.queryOrder({ subMchId: settings.mchId, outTradeNo, nonceStr: nonce() })
    if (res.returnCode === 'SUCCESS' && res.resultCode === 'SUCCESS' && res.tradeState === 'SUCCESS') {
      return { transactionId: res.transactionId || '', totalFee: Number(res.totalFee) }
    }
  } catch (e) {
    console.error('queryOrder failed', e)
  }
  return null
}

// 原路退款；refundFee 默认全额
async function refund(cloud, settings, { outTradeNo, outRefundNo, totalFee, refundFee, functionName }) {
  if (!settings.mchId) throw new BizError('没有商户号，退不了款')
  let res
  try {
    res = await cloud.cloudPay.refund({
      subMchId: settings.mchId,
      nonceStr: nonce(),
      outTradeNo,
      outRefundNo,
      totalFee,
      refundFee: refundFee || totalFee,
      envId: envOf(cloud),
      functionName
    })
  } catch (e) {
    console.error('refund failed', e)
    throw new BizError('微信退款失败：' + (e.errMsg || e.message || '请稍后再试'))
  }
  if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS') {
    console.error('refund result', res)
    throw new BizError('微信退款失败：' + (res.errCodeDes || res.returnMsg || '请稍后再试'))
  }
  return true
}

// 微信支付的回调事件没有 action，带着 outTradeNo；退款回调带 reqInfo，直接忽略
function isPayNotify(event) {
  return !!event && !event.action && typeof event.outTradeNo === 'string' && 'returnCode' in event && !event.reqInfo
}

function isRefundNotify(event) {
  return !!event && !event.action && !!event.reqInfo
}

// 包一层云函数入口：支付回调先处理，其他照常走 createMain
function withPayNotify(main, onNotify) {
  return async (event) => {
    if (isRefundNotify(event)) return { errcode: 0, errmsg: '' }
    if (!isPayNotify(event)) return main(event)
    try {
      await onNotify(event)
      return { errcode: 0, errmsg: '' }
    } catch (e) {
      // 出错时让微信过一会儿再通知一次
      console.error('pay notify failed', e)
      return { errcode: -1, errmsg: 'retry' }
    }
  }
}

module.exports = { getSettings, publicPay, unifiedOrder, queryPaid, refund, withPayNotify }
