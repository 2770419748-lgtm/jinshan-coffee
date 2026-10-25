// 第 4 步：微信支付。咖啡订单、借书租金、超时费；支付通知要向微信查单确认；取消已付的单原路退款
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, setDoc, modules } = require('./helpers/load')

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

// 模拟服务器收到微信支付通知（解密之后交给模块的那一步）
function notify(name, outTradeNo) {
  return modules[name].onPayNotify({ outTradeNo })
}

let menu
let shelf

test('准备：店主、菜单、书', async () => {
  db.reset()
  state.payReady = true
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

test('店铺设置：只有店主能改；服务器上没配好微信支付时打不开', async () => {
  await fails(alice.common('saveShopSettings', { payEnabled: true }), 'FORBIDDEN')
  state.payReady = false
  const res = await fails(owner.common('saveShopSettings', { payEnabled: true }))
  assert.match(res.msg, /服务器上还没配置微信支付/)
  assert.deepEqual(await ok(owner.common('getShopSettings')), { payEnabled: false, payReady: false, mchId: '', allowCounter: true })
  state.payReady = true
  await fails(owner.common('saveShopSettings', { payEnabled: false, allowCounter: false }))
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true }))
  assert.deepEqual(await ok(owner.common('getShopSettings')), { payEnabled: true, payReady: true, mchId: '1900000109', allowCounter: true })
})

test('咖啡：微信支付，回调要查单确认，伪造的回调不算数', async () => {
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 2 }] }))
  const order = await ok(alice.coffee('getOrder', { id }))
  assert.deepEqual(order.pay, { enabled: true, allowCounter: true })
  await fails(bob.coffee('payOrder', { id }))
  const { payment } = await ok(alice.coffee('payOrder', { id }))
  assert.match(payment.package, /^prepay_id=/)
  const sent = state.payOrders[order.orderNo].params
  assert.equal(sent.total, 6400)
  assert.equal(sent.openid, 'ALICE', '付款人是下单的顾客')
  assert.equal(sent.notifyPath, '/pay/notify/coffee')
  assert.match(sent.description, /^进山咖啡-取餐号/)

  // 通知到了但向微信查单发现没付（比如伪造的通知），不算
  await notify('coffee', order.orderNo)
  assert.equal((await ok(alice.coffee('getOrder', { id }))).payStatus, 'unpaid')
  assert.deepEqual(await ok(alice.coffee('confirmPay', { id })), { payStatus: 'unpaid' })
  // 通知不再走 api 入口：没有 action 的请求一律拒绝
  assert.equal((await alice.coffee(undefined, { outTradeNo: order.orderNo })).code, 'UNKNOWN_ACTION')

  // 真付了：通知把订单标成已付
  state.payOrders[order.orderNo].paid = true
  await notify('coffee', order.orderNo)
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
  assert.deepEqual(state.refunds.map((r) => [r.outTradeNo, r.outRefundNo, r.total, r.refund]), [[order.orderNo, 'R' + order.orderNo, 6400, 6400]])
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
  await notify('coffee', order.orderNo)
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
  assert.equal(state.payOrders[r1.rentalNo].params.notifyPath, '/pay/notify/book')
  state.payOrders[r1.rentalNo].paid = true
  await notify('book', r1.rentalNo)
  const paid = await ok(alice.book('getRental', { id: day.id }))
  assert.equal(paid.payStatus, 'paid')
  assert.equal(paid.payMethod, 'wechat')
  assert.equal(paid.voucherCount, 1)
  assert.equal((await ok(alice.coffee('myVouchers'))).usable.length, 1)
  // 通知重复到达也不会多发券
  await notify('book', r1.rentalNo)
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
  await setDoc('book_rentals', h.id, { dueAt: new Date(Date.now() - 90 * 60000) })
  const ret = await ok(owner.book('returnBook', { id: h.id }))
  assert.equal(ret.overtimeFee, 1600)
  await fails(bob.book('payRental', { id: h.id, kind: 'overtime' }))
  await ok(alice.book('payRental', { id: h.id, kind: 'overtime' }))
  const otNo = 'JO' + r2.rentalNo.slice(2)
  assert.equal(state.payOrders[otNo].params.total, 1600)
  // 金额对不上的不算
  state.payOrders[otNo].paid = true
  state.payOrders[otNo].params.total = 1
  await notify('book', otNo)
  assert.equal((await ok(alice.book('getRental', { id: h.id }))).overtimePayStatus, 'unpaid')
  state.payOrders[otNo].params.total = 1600
  await notify('book', otNo)
  const done = await ok(alice.book('getRental', { id: h.id }))
  assert.equal(done.overtimePayStatus, 'paid')
  assert.equal(done.overtimePayMethod, 'wechat')
})

test('商户号没配好时给出明白的提示', async () => {
  state.payFail = true
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }] }))
  const res = await fails(alice.coffee('payOrder', { id }))
  assert.match(res.msg, /商户号未开通 JSAPI 支付/)
  state.payFail = false
})

test('服务器上的支付配置撤掉后，开关不再生效，顾客只能到吧台付', async () => {
  state.payReady = false
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }] }))
  assert.deepEqual((await ok(alice.coffee('getOrder', { id }))).pay, { enabled: false, allowCounter: true })
  await fails(alice.coffee('payOrder', { id }), 'PAY_DISABLED')
  state.payReady = true
})
