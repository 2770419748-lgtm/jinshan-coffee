// 第 4 步：微信支付。咖啡订单、借书租金、超时费；回调要向微信查单确认；取消已付的单原路退款
const test = require('node:test')
const assert = require('node:assert/strict')
const { cloud, as, unwrap } = require('./helpers/load')
const coffeeFn = require('../cloudfunctions/coffee/index.js')
const bookFn = require('../cloudfunctions/book/index.js')

const owner = as('OWNER')
const alice = as('ALICE')
const bob = as('BOB')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}
const state = cloud.__state

// 模拟微信服务器调用支付回调（没有 openid、没有 action）
async function notify(fn, outTradeNo, totalFee) {
  state.openid = ''
  return fn.main({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo, totalFee, transactionId: 'tx' + outTradeNo })
}

let menu
let shelf

test('准备：店主、菜单、书', async () => {
  cloud.__db.reset()
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
  menu = await ok(alice.coffee('getMenu'))
  shelf = await ok(alice.book('getShelf'))
})

const pour = () => menu.products.find((p) => p.name === '手冲')

test('没开通时只能到吧台付款', async () => {
  const quote = await ok(alice.coffee('quote', { items: [{ productId: pour()._id, qty: 1 }] }))
  assert.deepEqual(quote.pay, { enabled: false, allowCounter: true })
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }] }))
  await fails(alice.coffee('payOrder', { id }), 'PAY_DISABLED')
})

test('店铺设置：只有店主能改；打开前要填商户号', async () => {
  await fails(alice.common('saveShopSettings', { payEnabled: true, mchId: '1900000109' }), 'FORBIDDEN')
  await fails(owner.common('saveShopSettings', { payEnabled: true, mchId: '' }))
  await fails(owner.common('saveShopSettings', { payEnabled: true, mchId: 'abc' }))
  await fails(owner.common('saveShopSettings', { payEnabled: false, allowCounter: false }))
  await ok(owner.common('saveShopSettings', { payEnabled: true, mchId: '1900000109', allowCounter: true }))
  assert.deepEqual(await ok(owner.common('getShopSettings')), { payEnabled: true, mchId: '1900000109', allowCounter: true })
})

test('咖啡：微信支付，回调要查单确认，伪造的回调不算数', async () => {
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 2 }] }))
  const order = await ok(alice.coffee('getOrder', { id }))
  assert.deepEqual(order.pay, { enabled: true, allowCounter: true })
  await fails(bob.coffee('payOrder', { id }))
  const { payment } = await ok(alice.coffee('payOrder', { id }))
  assert.match(payment.package, /^prepay_id=/)
  const sent = state.payOrders[order.orderNo].params
  assert.equal(sent.totalFee, 6400)
  assert.equal(sent.subMchId, '1900000109')
  assert.equal(sent.functionName, 'coffee')
  assert.equal(sent.envId, 'env-test')

  // 顾客自己伪造一个回调：查单发现没付，不算
  const fake = await alice.coffee(undefined, { returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: order.orderNo, totalFee: 6400 })
  assert.deepEqual(fake, { errcode: 0, errmsg: '' })
  assert.equal((await ok(alice.coffee('getOrder', { id }))).payStatus, 'unpaid')
  assert.deepEqual(await ok(alice.coffee('confirmPay', { id })), { payStatus: 'unpaid' })

  // 真付了：回调把订单标成已付
  state.payOrders[order.orderNo].paid = true
  assert.deepEqual(await notify(coffeeFn, order.orderNo, 6400), { errcode: 0, errmsg: '' })
  const paid = await ok(alice.coffee('getOrder', { id }))
  assert.equal(paid.payStatus, 'paid')
  assert.equal(paid.payMethod, 'wechat')
  assert.equal(paid.transactionId, 'tx' + order.orderNo)
  await fails(alice.coffee('payOrder', { id }))
  await fails(alice.coffee('cancelOrder', { id }))

  // 店员取消：先原路退款
  await ok(owner.coffee('setOrderStatus', { id, status: 'cancelled' }))
  const refunded = await ok(alice.coffee('getOrder', { id }))
  assert.equal(refunded.status, 'cancelled')
  assert.equal(refunded.payStatus, 'refunded')
  assert.deepEqual(state.refunds.map((r) => [r.outTradeNo, r.outRefundNo, r.refundFee]), [[order.orderNo, 'R' + order.orderNo, 6400]])
  const sum = await ok(owner.coffee('daySummary', {}))
  assert.equal(sum.totals.cancelledPaidFee, 0, '已经在线退款的不再提醒')
})

test('咖啡：回调没到时，顾客端查单补上', async () => {
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }] }))
  await ok(alice.coffee('payOrder', { id }))
  const order = await ok(alice.coffee('getOrder', { id }))
  state.payOrders[order.orderNo].paid = true
  assert.deepEqual(await ok(alice.coffee('confirmPay', { id })), { payStatus: 'paid' })
  const sum = await ok(owner.coffee('daySummary', {}))
  assert.equal(sum.totals.wechatFee, 3200)
})

test('咖啡：付款途中取消了，钱到了自动退回', async () => {
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }] }))
  await ok(alice.coffee('payOrder', { id }))
  const order = await ok(alice.coffee('getOrder', { id }))
  await ok(alice.coffee('cancelOrder', { id }))
  state.payOrders[order.orderNo].paid = true
  await notify(coffeeFn, order.orderNo, 3200)
  assert.equal((await ok(alice.coffee('getOrder', { id }))).payStatus, 'refunded')
})

test('赠饮券全抵了，不用付钱', async () => {
  const dayRule = shelf.rules.find((r) => r.type === 'day')
  await ok(owner.book('saveRule', { rule: Object.assign({}, dayRule, { freeMaxFee: 0 }) }))
  const { id } = await ok(bob.book('createRental', { bookId: shelf.books[0]._id, ruleId: dayRule._id }))
  await ok(owner.book('markRentalPaid', { id }))
  const items = [{ productId: pour()._id, qty: 1 }]
  const quote = await ok(bob.coffee('quote', { items }))
  assert.equal(quote.payFee, 0)
  const order = await ok(bob.coffee('createOrder', { mode: 'takeaway', items, voucherIds: quote.applied.map((a) => a.id) }))
  const o = await ok(bob.coffee('getOrder', { id: order.id }))
  assert.equal(o.payStatus, 'paid')
  assert.equal(o.payMethod, 'voucher')
})

test('借书：微信付租金后发赠饮券，超时费也能微信付', async () => {
  const dayRule = shelf.rules.find((r) => r.type === 'day')
  const hourly = shelf.rules.find((r) => r.type === 'hourly')
  const book = shelf.books.find((b) => b.title === '小王子')

  const day = await ok(alice.book('createRental', { bookId: book._id, ruleId: dayRule._id }))
  const r1 = await ok(alice.book('getRental', { id: day.id }))
  assert.equal(r1.pay.enabled, true)
  await ok(alice.book('payRental', { id: day.id }))
  assert.equal(state.payOrders[r1.rentalNo].params.functionName, 'book')
  state.payOrders[r1.rentalNo].paid = true
  await notify(bookFn, r1.rentalNo, 3900)
  const paid = await ok(alice.book('getRental', { id: day.id }))
  assert.equal(paid.payStatus, 'paid')
  assert.equal(paid.payMethod, 'wechat')
  assert.equal(paid.voucherCount, 1)
  assert.equal((await ok(alice.coffee('myVouchers'))).usable.length, 1)
  // 回调重复到达也不会多发券
  await notify(bookFn, r1.rentalNo, 3900)
  assert.equal((await ok(alice.coffee('myVouchers'))).usable.length, 1)

  // 店员取消已经微信付款的借阅：原路退款，券作废
  const cancel = await ok(owner.book('adminCancelRental', { id: day.id }))
  assert.deepEqual(cancel, { paid: false, refunded: true, voidedVouchers: 1 })
  assert.equal((await ok(alice.book('getRental', { id: day.id }))).payStatus, 'refunded')

  // 按小时：先付租金，超时后补超时费
  const h = await ok(alice.book('createRental', { bookId: book._id, ruleId: hourly._id, hours: 1 }))
  await ok(alice.book('payRental', { id: h.id }))
  const r2 = await ok(alice.book('getRental', { id: h.id }))
  state.payOrders[r2.rentalNo].paid = true
  assert.deepEqual(await ok(alice.book('confirmPay', { id: h.id })), { payStatus: 'paid' })
  await ok(owner.book('handOut', { id: h.id }))
  cloud.__db.collections.book_rentals[h.id].dueAt = new Date(Date.now() - 90 * 60000)
  const ret = await ok(owner.book('returnBook', { id: h.id }))
  assert.equal(ret.overtimeFee, 1600)
  await fails(bob.book('payRental', { id: h.id, kind: 'overtime' }))
  await ok(alice.book('payRental', { id: h.id, kind: 'overtime' }))
  const otNo = 'JO' + r2.rentalNo.slice(2)
  assert.equal(state.payOrders[otNo].params.totalFee, 1600)
  // 金额对不上的不算
  state.payOrders[otNo].paid = true
  state.payOrders[otNo].params.totalFee = 1
  await notify(bookFn, otNo, 1)
  assert.equal((await ok(alice.book('getRental', { id: h.id }))).overtimePayStatus, 'unpaid')
  state.payOrders[otNo].params.totalFee = 1600
  await notify(bookFn, otNo, 1600)
  const done = await ok(alice.book('getRental', { id: h.id }))
  assert.equal(done.overtimePayStatus, 'paid')
  assert.equal(done.overtimePayMethod, 'wechat')
})

test('商户号没配好时给出明白的提示', async () => {
  state.payFail = true
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }] }))
  const res = await fails(alice.coffee('payOrder', { id }))
  assert.match(res.msg, /商户号未绑定/)
  state.payFail = false
})

test('退款回调直接回复收到', async () => {
  state.openid = ''
  assert.deepEqual(await coffeeFn.main({ reqInfo: 'xxx', returnCode: 'SUCCESS' }), { errcode: 0, errmsg: '' })
})
