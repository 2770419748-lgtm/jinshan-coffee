// 洗车会员：余额和咖啡分开、会员号通用、洗车商户号在线充值、到店代充、次卡（买、用、连点、过期、退卡）、
// 充值和办卡送咖啡券（咖啡下单能抵、洗车不抵、撤回后不能用）、店长调整、权限、汇总
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc, setDoc, modules } = require('./helpers/load')
const { cnDay } = require('../server/functions/base')
const wallet = require('../server/functions/wallet')

const owner = as('OWNER')
const manager = as('MGR')
const tech = as('TECH')
const barista = as('BARISTA')
const inCarwash = (id) => as(id, { app: 'carwash', appOpenid: 'CW_' + id })
const inCoffee = (id) => as(id, { app: 'coffee', appOpenid: 'CF_' + id })
const alice = inCarwash('ALICE')
const aliceCoffee = inCoffee('ALICE')
const bob = inCarwash('BOB')
const dave = inCarwash('DAVE')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

let coffeePlan
let plan300
let plan500
let wash
let polish
let card10
let aliceNo
const cwBalance = async (id) => (await getDoc('cw_members', id)).balance
const vouchersOf = async (id) => (await db.collection('vouchers').where({ _openid: id }).orderBy('createdAt', 'asc').limit(100).get()).data

test('准备：店主、洗车店长、技师、咖啡师、两个服务项目', async () => {
  db.reset()
  state.payReady = true
  state.cw.payReady = true
  await ok(owner.common('bindOwner', { name: '坤总' }))
  const m = await ok(owner.common('createInvite', { role: 'carwash_manager' }))
  await ok(manager.common('bindStaff', { code: m.code, name: '老王' }))
  const t = await ok(manager.carwash('createTechInvite', {}))
  await ok(tech.common('bindStaff', { code: t.code, name: '小李' }))
  const b = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: b.code, name: '咖啡师' }))
  wash = (await ok(manager.carwash('saveService', { service: { name: '标准洗车', price: 5000, modes: ['store'] } }))).id
  polish = (await ok(manager.carwash('saveService', { service: { name: '打蜡', price: 20000, modes: ['store'] } }))).id
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true }))
  await ok(owner.member('saveMemberSettings', { enabled: true }))
  coffeePlan = (await ok(owner.member('savePlan', { plan: { price: 10000, bonus: 0 } }))).id
})

test('会员号两边通用：先开洗车会员中心的人，到咖啡还是这个号', async () => {
  const cw = await ok(alice.carwash('getMember'))
  aliceNo = cw.member.memberNo
  assert.match(aliceNo, /^\d{5}$/)
  const cf = await ok(aliceCoffee.member('getMember'))
  assert.equal(cf.member.memberNo, aliceNo)
  const bobCf = await ok(inCoffee('BOB').member('getMember'))
  const bobCw = await ok(bob.carwash('getMember'))
  assert.equal(bobCw.member.memberNo, bobCf.member.memberNo)
  assert.notEqual(bobCw.member.memberNo, aliceNo)
})

test('储值设置：只有店长、店主能改；没开时顾客看不到档位', async () => {
  await fails(tech.carwash('saveMemberSettings', { enabled: true }), 'FORBIDDEN')
  await fails(barista.carwash('getMemberSettings'), 'FORBIDDEN')
  assert.deepEqual((await ok(alice.carwash('getMember'))).plans, [])
  await ok(manager.carwash('saveMemberSettings', { enabled: true, notice: '储值只能在黑镜洗车使用', refundNotice: '退费扣除已赠送金额' }))
  await fails(manager.carwash('savePlan', { plan: { price: 0 } }))
  await fails(manager.carwash('savePlan', { plan: { price: 30000, memberDays: 4000 } }))
  plan300 = (await ok(manager.carwash('savePlan', { plan: { price: 30000, bonus: 5000, memberDays: 365 } }))).id
  plan500 = (await ok(owner.carwash('savePlan', { plan: { price: 50000, bonus: 10000, memberDays: 365 } }))).id
  const me = await ok(alice.carwash('getMember'))
  assert.deepEqual(me.plans.map((p) => p.title), ['充 300 送 50', '充 500 送 100'])
  assert.equal(me.settings.refundNotice, '退费扣除已赠送金额')
})

test('送咖啡券规则：检查格式；充值按最高一档送，办次卡按卡的种类送', async () => {
  await fails(manager.carwash('saveLinkRule', { rule: { trigger: 'x' } }))
  await fails(manager.carwash('saveLinkRule', { rule: { trigger: 'recharge', minAmount: 30000, count: 0, amount: 1500, validDays: 30 } }))
  await fails(manager.carwash('saveLinkRule', { rule: { trigger: 'recharge', minAmount: 30000, count: 2, amount: 30000, validDays: 30 } }))
  await fails(manager.carwash('saveLinkRule', { rule: { trigger: 'card', cardTypeId: 'nope', count: 1, amount: 1500, validDays: 30 } }))
  await fails(tech.carwash('saveLinkRule', { rule: { trigger: 'recharge', minAmount: 30000, count: 2, amount: 1500, validDays: 30 } }), 'FORBIDDEN')
  await ok(manager.carwash('saveLinkRule', { rule: { trigger: 'recharge', minAmount: 30000, count: 2, amount: 1500, minSpend: 3000, validDays: 30 } }))
  await ok(manager.carwash('saveLinkRule', { rule: { trigger: 'recharge', minAmount: 50000, count: 4, amount: 1500, validDays: 60 } }))
  const { rules } = await ok(manager.carwash('listLinkRules'))
  assert.equal(rules[0].text, '充值满 300 元，送 2 张 ¥15 咖啡券（满 30 可用），30 天有效')
})

test('到店代充：充到洗车的账上，送咖啡券；咖啡的余额不动', async () => {
  await fails(barista.carwash('counterRecharge', { memberNo: aliceNo, planId: plan300 }), 'FORBIDDEN')
  await fails(tech.carwash('counterRecharge', { memberNo: '99999', planId: plan300 }), 'MEMBER_NOT_FOUND')
  const res = await ok(tech.carwash('counterRecharge', { memberNo: aliceNo, planId: plan300 }))
  assert.equal(res.balance, 35000)
  assert.equal(res.vouchers, 2)
  assert.equal((await getDoc('members', 'ALICE')).balance, 0)
  const vs = await vouchersOf('ALICE')
  assert.equal(vs.length, 2)
  assert.equal(vs[0].issuedBy, 'carwash')
  assert.deepEqual(vs[0].usableShops, ['coffee'])
  assert.equal(vs[0].amount, 1500)
  assert.equal(vs[0].expiresDay, wallet.addDays(cnDay(), 29))
  const logs = await ok(alice.carwash('myMemberLogs'))
  assert.equal(logs.logs[0].typeName, '吧台充值')
  assert.equal(logs.logs[0].amount, 35000)
  // 咖啡那边的流水里没有
  assert.equal((await db.collection('member_logs').where({ _openid: 'ALICE' }).count()).total, 0)
  assert.equal((await ok(alice.carwash('getMember'))).member.isMember, true)
})

test('咖啡下单自动抵洗车送的券；洗车不抵；只能在别的店用的券咖啡不认', async () => {
  // 一张标了只能洗车用的券（以后可能有），咖啡不能用
  await db.collection('vouchers').add({ data: { _openid: 'ALICE', type: 'cash', couponId: 'cw:x', title: '洗车专用', amount: 5000, minSpend: 0, expiresDay: wallet.addDays(cnDay(), 10), status: 'unused', issuedBy: 'carwash', usableShops: ['carwash'], createdAt: new Date() } })
  await ok(owner.coffee('seedDemo'))
  const menu = await ok(aliceCoffee.coffee('getMenu'))
  const pour = menu.products.find((p) => p.name === '手冲') // 32 元
  const quote = await ok(aliceCoffee.coffee('quote', { items: [{ productId: pour._id, qty: 1 }] }))
  assert.equal(quote.couponFee, 1500)
  assert.equal(quote.coupons.length, 2, '两张洗车送的券能选，洗车专用的那张不在里面')
  const order = await ok(aliceCoffee.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour._id, qty: 1 }], couponId: quote.coupon.id }))
  const saved = await getDoc('coffee_orders', order.id)
  assert.equal(saved.couponFee, 1500)
  assert.equal(saved.payFee, 1700)
  const left = (await vouchersOf('ALICE')).filter((v) => v.status === 'unused' && v.usableShops[0] === 'coffee')
  assert.equal(left.length, 1)
  // 洗车两个小程序看到的是同一批券
  const mine = await ok(alice.carwash('myVouchers'))
  assert.equal(mine.usable.length, 2)
  assert.equal(mine.others[0].status, 'used')
  assert.equal(mine.usable[0].usableAt, '进山咖啡')
})

test('洗车商户号在线充值：通知重复到达只加一次钱、只送一次券；充 500 只拿最高一档', async () => {
  state.cw.payOrders = {}
  state.payOrders = {}
  await ok(manager.carwash('saveSettings', { settings: { payEnabled: true } }))
  const r = await ok(bob.carwash('createRecharge', { planId: plan500 }))
  const recharge = await getDoc('cw_recharges', r.id)
  assert.match(recharge.rechargeNo, /^CC/)
  const sent = state.cw.payOrders[recharge.rechargeNo].params
  assert.equal(sent.openid, 'CW_BOB')
  assert.equal(sent.notifyPath, '/pay/notify/carwash')
  assert.equal(Object.keys(state.payOrders).length, 0)
  assert.deepEqual(await ok(bob.carwash('confirmRecharge', { id: r.id })), { payStatus: 'unpaid' })
  state.cw.payOrders[recharge.rechargeNo].paid = true
  await Promise.all([
    modules.carwash.onPayNotify({ outTradeNo: recharge.rechargeNo }),
    modules.carwash.onPayNotify({ outTradeNo: recharge.rechargeNo }),
    ok(bob.carwash('confirmRecharge', { id: r.id }))
  ])
  assert.equal(await cwBalance('BOB'), 60000)
  assert.equal((await db.collection('cw_member_logs').where({ _openid: 'BOB', type: 'recharge' }).count()).total, 1)
  const vs = await vouchersOf('BOB')
  assert.equal(vs.length, 4, '满 500 那档送 4 张，不叠加满 300 的 2 张')
  assert.equal(vs[0].expiresDay, wallet.addDays(cnDay(), 59))
  // 从咖啡小程序充洗车的钱不行
  await fails(inCoffee('BOB').carwash('createRecharge', { planId: plan500 }), 'WRONG_APP')
})

test('次卡种类：价格、次数、有效期、适用项目检查', async () => {
  await fails(manager.carwash('saveCardType', { cardType: { name: '洗车卡', price: 40000, times: 10, validDays: 365, serviceIds: [] } }))
  await fails(manager.carwash('saveCardType', { cardType: { name: '洗车卡', price: 40000, times: 0, validDays: 365, serviceIds: [wash] } }))
  await fails(manager.carwash('saveCardType', { cardType: { name: '洗车卡', price: 40000, times: 10, serviceIds: [wash] } }))
  await fails(manager.carwash('saveCardType', { cardType: { price: 40000, times: 10, validDays: 365, serviceIds: [wash] } }))
  card10 = (await ok(manager.carwash('saveCardType', { cardType: { name: '洗车 10 次卡', price: 40000, times: 10, validDays: 365, serviceIds: [wash, 'nope'] } }))).id
  const t = await getDoc('cw_card_types', card10)
  assert.deepEqual(t.serviceIds, [wash])
  await ok(manager.carwash('saveLinkRule', { rule: { trigger: 'card', cardTypeId: card10, count: 1, amount: 2000, validDays: 30 } }))
  const me = await ok(alice.carwash('getMember'))
  assert.deepEqual(me.cardTypes.map((c) => [c.name, c.serviceNames.join()]), [['洗车 10 次卡', '标准洗车']])
})

test('用余额办卡：扣余额、开卡、送券；余额不够办不了', async () => {
  await fails(alice.carwash('buyCard', { typeId: card10, payBy: 'balance' }), 'BALANCE_LOW')
  assert.equal(await cwBalance('ALICE'), 35000)
  assert.equal((await db.collection('cw_cards').where({ _openid: 'ALICE' }).count()).total, 0)
  const res = await ok(bob.carwash('buyCard', { typeId: card10, payBy: 'balance' }))
  assert.equal(res.paid, true)
  assert.equal(await cwBalance('BOB'), 20000)
  const card = await getDoc('cw_cards', res.cardId)
  assert.equal(card.remaining, 10)
  assert.equal(card.source, 'balance')
  assert.equal(card.expiresDay, wallet.addDays(cnDay(), 364))
  assert.deepEqual(card.serviceNames, ['标准洗车'])
  assert.equal((await vouchersOf('BOB')).length, 5, '办卡又送了 1 张')
  await fails(bob.carwash('buyCard', { typeId: card10 }))
})

test('微信办卡：通知重复到达只开一张卡', async () => {
  const r = await ok(alice.carwash('buyCard', { typeId: card10, payBy: 'wechat' }))
  const order = await getDoc('cw_card_orders', r.id)
  assert.match(order.buyNo, /^CK/)
  assert.equal(state.cw.payOrders[order.buyNo].params.total, 40000)
  state.cw.payOrders[order.buyNo].paid = true
  await Promise.all([
    modules.carwash.onPayNotify({ outTradeNo: order.buyNo }),
    modules.carwash.onPayNotify({ outTradeNo: order.buyNo }),
    ok(alice.carwash('confirmCardPay', { id: r.id }))
  ])
  const cards = (await ok(alice.carwash('myCards'))).cards
  assert.equal(cards.length, 1)
  assert.equal(cards[0].remaining, 10)
  assert.equal(cards[0].state, 'active')
  assert.equal((await getDoc('cw_card_orders', r.id)).payStatus, 'paid')
  assert.equal((await vouchersOf('ALICE')).filter((v) => v.refNo === order.buyNo).length, 1)
  assert.equal(await cwBalance('ALICE'), 35000, '微信付的不动余额')
})

test('到店用卡：连点两下只扣一次；项目不对、次数用完、过期都拒绝', async () => {
  const [card] = (await ok(alice.carwash('myCards'))).cards
  await fails(barista.carwash('staffUseCard', { memberNo: aliceNo, cardId: card._id }), 'FORBIDDEN')
  await fails(tech.carwash('staffUseCard', { memberNo: aliceNo, cardId: card._id, serviceId: polish }), 'CARD_NOT_FOR_SERVICE')
  const nonce = 'tap-12345678'
  const [a, b] = await Promise.all([
    ok(tech.carwash('staffUseCard', { memberNo: aliceNo, cardId: card._id, serviceId: wash, nonce })),
    ok(tech.carwash('staffUseCard', { memberNo: aliceNo, cardId: card._id, serviceId: wash, nonce }))
  ])
  assert.deepEqual([a.remaining, b.remaining], [9, 9])
  assert.equal([a.duplicate, b.duplicate].filter(Boolean).length, 1)
  assert.equal((await getDoc('cw_cards', card._id)).remaining, 9)
  // 别人的卡用不了
  const bobNo = (await ok(bob.carwash('getMember'))).member.memberNo
  await fails(tech.carwash('staffUseCard', { memberNo: bobNo, cardId: card._id }), 'CARD_GONE')
  // 次数用完
  await setDoc('cw_cards', card._id, { remaining: 1 })
  await ok(tech.carwash('staffUseCard', { memberNo: aliceNo, cardId: card._id }))
  await fails(tech.carwash('staffUseCard', { memberNo: aliceNo, cardId: card._id }), 'CARD_EMPTY')
  assert.equal((await getDoc('cw_cards', card._id)).remaining, 0)
  // 过期
  await setDoc('cw_cards', card._id, { remaining: 5, expiresDay: wallet.addDays(cnDay(), -1) })
  await fails(tech.carwash('staffUseCard', { memberNo: aliceNo, cardId: card._id }), 'CARD_EXPIRED')
  assert.equal((await ok(alice.carwash('myCards'))).cards[0].state, 'expired')
  const logs = await ok(alice.carwash('myCardLogs', { cardId: card._id }))
  assert.deepEqual(logs.logs.map((l) => l.change), [-1, -1, 10])
})

test('预约用次卡抵项目价；取消时退回次数；用卡的单超时取消扣这一次', async () => {
  const [card] = (await ok(alice.carwash('myCards'))).cards
  await setDoc('cw_cards', card._id, { remaining: 3, expiresDay: '' })
  await ok(manager.carwash('saveSettings', { settings: {
    hours: { open: '09:00', close: '18:00' }, slotMinutes: 60, storeCapacity: 2, doorCapacity: 0, bookDays: 2, leadMinutes: 0,
    freeCancelMinutes: 120, lateCancel: 'fee', lateCancelFee: 1000, autoConfirmHours: 24, payLater: true, payEnabled: true, bookingEnabled: true
  } }))
  const info = await ok(alice.carwash('getBookingInfo', { serviceId: wash }))
  assert.equal(info.cards.length, 1)
  const at = info.days[1].slots[0].start
  const q = await ok(alice.carwash('quote', { serviceId: wash, mode: 'store', cardId: card._id }))
  assert.equal(q.cardCover, 5000)
  assert.equal(q.payFee, 0)
  const o = await ok(alice.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, cardId: card._id }))
  let saved = await getDoc('cw_orders', o.id)
  assert.equal(saved.payStatus, 'paid')
  assert.equal(saved.payMethod, 'card')
  assert.equal((await getDoc('cw_cards', card._id)).remaining, 2)
  await ok(alice.carwash('cancelOrder', { id: o.id }))
  assert.equal((await getDoc('cw_cards', card._id)).remaining, 3)
  await fails(alice.carwash('cancelOrder', { id: o.id }))
  assert.equal((await getDoc('cw_cards', card._id)).remaining, 3, '只退一次')

  const late = await ok(alice.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, cardId: card._id }))
  await setDoc('cw_orders', late.id, { slotStart: Date.now() + 30 * 60000 })
  assert.deepEqual(await ok(alice.carwash('cancelOrder', { id: late.id })), { fee: 1000 })
  assert.equal((await getDoc('cw_cards', card._id)).remaining, 2, '超时取消，这一次不退')
  saved = await getDoc('cw_orders', late.id)
  assert.equal(saved.status, 'cancelled')
  // 洗车下单从来不抵咖啡券
  const q2 = await ok(alice.carwash('quote', { serviceId: wash, mode: 'store' }))
  assert.equal(q2.payFee, 5000)
  assert.equal(q2.couponFee, undefined)
})

test('店长调整余额、次卡：必须写原因；技师调不了', async () => {
  await fails(tech.carwash('adjustMember', { memberNo: aliceNo, amount: -1000, reason: '线下退款' }), 'FORBIDDEN')
  await fails(manager.carwash('adjustMember', { memberNo: aliceNo, amount: -1000 }))
  await fails(manager.carwash('adjustMember', { memberNo: aliceNo, amount: -9999999, reason: 'x' }))
  await fails(manager.carwash('adjustMember', { memberNo: aliceNo, amount: -100000, reason: '线下退款' }), 'BALANCE_LOW')
  const res = await ok(manager.carwash('adjustMember', { memberNo: aliceNo, amount: -5000, reason: '线下退款' }))
  assert.equal(res.balance, 30000)
  const detail = await ok(manager.carwash('getMemberDetail', { memberNo: aliceNo }))
  assert.equal(detail.logs[0].reason, '线下退款')
  assert.equal(detail.logs[0].operatorName, '老王')
  assert.ok(detail.vouchers.length >= 3)
  const card = detail.cards[0]
  await fails(manager.carwash('adjustCard', { cardId: card._id, times: 2 }))
  await fails(manager.carwash('adjustCard', { cardId: card._id, times: -99, reason: '录错了' }))
  const adj = await ok(manager.carwash('adjustCard', { cardId: card._id, times: 1, expiresDay: '2027-12-31', reason: '补偿' }))
  assert.deepEqual(adj, { remaining: 3, expiresDay: '2027-12-31' })
})

test('退卡：剩余次数清零，登记退了多少钱；送的券里没用的一起撤回，咖啡就用不了了', async () => {
  const bobCard = (await ok(bob.carwash('myCards'))).cards[0]
  await fails(manager.carwash('refundCard', { cardId: bobCard._id, refundFee: 30000 }))
  await fails(manager.carwash('refundCard', { cardId: bobCard._id, refundFee: 50000, reason: '不想要了' }))
  const res = await ok(manager.carwash('refundCard', { cardId: bobCard._id, refundFee: 30000, reason: '不想要了', revokeVouchers: true }))
  assert.equal(res.revoked, 1)
  const card = await getDoc('cw_cards', bobCard._id)
  assert.equal(card.status, 'refunded')
  assert.equal(card.remaining, 0)
  assert.equal(card.refundFee, 30000)
  await fails(tech.carwash('staffUseCard', { memberNo: card.memberNo, cardId: card._id }), 'CARD_GONE')
  await fails(manager.carwash('refundCard', { cardId: bobCard._id, refundFee: 0, reason: '再退一次' }))
  const revoked = (await vouchersOf('BOB')).find((v) => v.status === 'revoked')
  assert.equal(revoked.refNo, card.refNo)
  const bobCoffee = inCoffee('BOB')
  const menu = await ok(bobCoffee.coffee('getMenu'))
  const pour = menu.products.find((p) => p.name === '手冲')
  const quote = await ok(bobCoffee.coffee('quote', { items: [{ productId: pour._id, qty: 1 }] }))
  assert.equal(quote.coupons.length, 4, '撤回的那张不在里面')
  // 店长单独撤回一张
  const one = (await vouchersOf('BOB')).find((v) => v.status === 'unused')
  await fails(manager.carwash('revokeVoucher', { id: one._id }))
  await ok(manager.carwash('revokeVoucher', { id: one._id, reason: '发错了' }))
  await fails(manager.carwash('revokeVoucher', { id: one._id, reason: '发错了' }))
})

test('店员按会员号查会员：只在咖啡那边有号的，也能直接给他开洗车的账', async () => {
  const daveCf = await ok(inCoffee('DAVE').member('getMember'))
  assert.equal(await getDoc('cw_members', 'DAVE'), null)
  const found = await ok(tech.carwash('staffFindMember', { memberNo: daveCf.member.memberNo }))
  assert.equal(found.member.memberNo, daveCf.member.memberNo)
  assert.equal(found.member.balance, 0)
  assert.equal(found.plans.length, 2)
  const sold = await ok(tech.carwash('counterSellCard', { memberNo: daveCf.member.memberNo, typeId: card10 }))
  assert.equal(sold.card.remaining, 10)
  assert.equal((await ok(dave.carwash('myCards'))).cards.length, 1)
})

test('会员列表、汇总；店长和店主能看，技师不能', async () => {
  await fails(tech.carwash('listMembers'), 'FORBIDDEN')
  const list = await ok(manager.carwash('listMembers', {}))
  assert.ok(list.members.length >= 3)
  const byNo = await ok(owner.carwash('listMembers', { keyword: aliceNo }))
  assert.equal(byNo.members[0].memberNo, aliceNo)
  const sum = await ok(manager.carwash('memberSummary', {}))
  const t = sum.totals
  assert.equal(t.counterFee, 30000)
  assert.equal(t.onlineFee, 50000)
  assert.equal(t.bonusFee, 15000)
  assert.equal(t.cardsSold, 3)
  assert.equal(t.cardFee, 80000, '用余额办的那张不重复算')
  assert.equal(sum.balanceTotal, 30000 + 20000)
})
