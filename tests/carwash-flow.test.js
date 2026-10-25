// 洗车预约：后台配置（不填齐不开放）、服务项目、时段容量和防超约、上门范围和费用、会员价、
// 技师接单到完成的状态流转、洗车商户号的微信支付、余额和到店付款、取消规则和退款、超时自动取消和自动确认
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc, setDoc, modules } = require('./helpers/load')

const owner = as('OWNER')
const manager = as('MGR')
const tech1 = as('TECH1')
const tech2 = as('TECH2')
const barista = as('BARISTA')
// 顾客从洗车小程序来：付款用洗车小程序里的 openid
const inCarwash = (id) => as(id, { app: 'carwash', appOpenid: 'CW_' + id })
const alice = inCarwash('ALICE')
const bob = inCarwash('BOB')
const carol = inCarwash('CAROL')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

// 店在成都；近的地址 0.5 公里左右，远的 11 公里左右
const SHOP_AT = { lat: 30.657, lng: 104.066 }
const NEAR = { lat: 30.66, lng: 104.07 }
const FAR = { lat: 30.757, lng: 104.066 }

const SETTINGS = {
  shopName: '黑镜车体护理车房',
  address: '测试路 1 号',
  phone: '028-12345678',
  location: SHOP_AT,
  hours: { open: '09:00', close: '18:00' },
  slotMinutes: 60,
  storeCapacity: 1,
  doorCapacity: 1,
  bookDays: 3,
  leadMinutes: 60,
  doorRadiusKm: 5,
  doorFee: 1000,
  outOfRange: 'reject',
  freeCancelMinutes: 120,
  lateCancel: 'fee',
  lateCancelFee: 1000,
  autoConfirmHours: 24,
  payEnabled: true,
  payLater: true,
  bookingEnabled: true
}

let wash // 标准洗车 50 元，会员 40，到店和上门都行
let detail // 精洗 120 元，只能到店
let info
let near
let far
const slot = (dayIndex, i) => info.days[dayIndex].slots[i].start

async function saveSettings(change) {
  const cur = (await ok(owner.carwash('getSettings'))).settings
  return owner.carwash('saveSettings', { settings: Object.assign({}, cur, change) })
}

test('准备：店主、洗车店长、两位技师', async () => {
  db.reset()
  state.cw.payReady = true
  await ok(owner.common('bindOwner', { name: '坤总' }))
  const inv = await ok(owner.common('createInvite', { role: 'carwash_manager' }))
  assert.equal(inv.roleName, '洗车店长')
  await ok(manager.common('bindStaff', { code: inv.code, name: '老王' }))
  await fails(manager.carwash('createTechInvite', { role: 'carwash_manager' }), 'BAD_REQUEST')
  for (const [who, name] of [[tech1, '小李'], [tech2, '小张']]) {
    const t = await ok(manager.carwash('createTechInvite', { role: 'technician' }))
    assert.equal(t.roleName, '洗车技师')
    await ok(who.common('bindStaff', { code: t.code, name }))
  }
  const binv = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: binv.code, name: '咖啡师' }))
  const techs = await ok(manager.carwash('listTechs'))
  assert.deepEqual(techs.map((t) => t.name).sort(), ['坤总', '小李', '小张', '老王'].sort())
})

test('权限：顾客、咖啡师、技师都改不了洗车设置；技师进不了咖啡后台', async () => {
  await fails(alice.carwash('getSettings'), 'FORBIDDEN')
  await fails(barista.carwash('saveService', { service: { name: 'x', price: 100, modes: ['store'] } }), 'FORBIDDEN')
  await fails(tech1.carwash('getSettings'), 'FORBIDDEN')
  await fails(tech1.coffee('listOrders'), 'FORBIDDEN')
  await fails(alice.carwash('staffOrders'), 'FORBIDDEN')
})

test('设置不给默认值：没填齐不开放预约，开放时列出还差哪几项', async () => {
  const s = await ok(manager.carwash('getSettings'))
  assert.equal(s.open, false)
  assert.equal(s.settings.slotMinutes, null)
  assert.equal(s.settings.storeCapacity, null)
  assert.equal(s.settings.doorRadiusKm, null)
  assert.equal(s.settings.lateCancel, null)
  assert.ok(s.problems.indexOf('营业时间') !== -1)
  const home = await ok(alice.carwash('getHome'))
  assert.equal(home.bookingOpen, false)
  await fails(alice.carwash('getBookingInfo', { serviceId: 'x' }), 'BOOKING_CLOSED')
  const res = await fails(manager.carwash('saveSettings', { settings: { bookingEnabled: true, hours: { open: '09:00', close: '18:00' } } }), 'SETTINGS_INCOMPLETE')
  assert.match(res.msg, /每段时长/)
  assert.match(res.msg, /免费取消时限/)
  await fails(manager.carwash('saveSettings', { settings: { hours: { open: '18:00', close: '09:00' } } }))
  await fails(manager.carwash('saveSettings', { settings: { slotMinutes: 5 } }))
  await fails(manager.carwash('saveSettings', { settings: { doorRadiusKm: -1 } }))
  // 洗车商户号没配好时不能开微信支付
  state.cw.payReady = false
  await fails(manager.carwash('saveSettings', { settings: { payEnabled: true } }))
  state.cw.payReady = true
})

test('服务项目：名称、价格、会员价、到店/上门检查', async () => {
  await fails(manager.carwash('saveService', { service: { price: 5000, modes: ['store'] } }))
  await fails(manager.carwash('saveService', { service: { name: '洗车', price: 0, modes: ['store'] } }))
  await fails(manager.carwash('saveService', { service: { name: '洗车', price: 5000, memberPrice: 6000, modes: ['store'] } }))
  await fails(manager.carwash('saveService', { service: { name: '洗车', price: 5000, modes: [] } }))
  wash = (await ok(manager.carwash('saveService', { service: { name: '标准洗车', price: 5000, memberPrice: 4000, minutes: 40, modes: ['store', 'door'] } }))).id
  detail = (await ok(manager.carwash('saveService', { service: { name: '精洗', price: 12000, modes: ['store'] } }))).id
  const off = (await ok(manager.carwash('saveService', { service: { name: '打蜡', price: 20000, modes: ['store'], enabled: false } }))).id
  const list = await ok(manager.carwash('adminListServices'))
  assert.deepEqual(list.map((s) => s.name), ['标准洗车', '精洗', '打蜡'])
  await ok(manager.carwash('deleteService', { id: off }))
})

test('填齐设置后开放预约；顾客看到项目、时段和名额', async () => {
  await ok(saveSettings(SETTINGS))
  const s = await ok(manager.carwash('getSettings'))
  assert.equal(s.open, true)
  assert.deepEqual(s.problems, [])
  const home = await ok(alice.carwash('getHome'))
  assert.equal(home.bookingOpen, true)
  assert.equal(home.shop.shopName, '黑镜车体护理车房')
  assert.deepEqual(home.services.map((x) => x.name), ['标准洗车', '精洗'])
  info = await ok(alice.carwash('getBookingInfo', { serviceId: wash }))
  assert.deepEqual(info.modes, ['store', 'door'])
  assert.equal(info.days.length, 3)
  assert.equal(info.days[1].label, '明天')
  // 9 点到 18 点每小时一段，最后一段 17:00-18:00
  assert.equal(info.days[1].slots.length, 9)
  assert.equal(info.days[1].slots[0].label, '09:00-10:00')
  assert.equal(info.days[1].slots[8].label, '17:00-18:00')
  assert.deepEqual(info.days[1].slots[0].left, { store: 1, door: 1 })
  assert.equal(info.unitPrice, 5000)
  assert.ok(info.policy.some((l) => /2 小时以前可以免费取消/.test(l)))
  const d = await ok(alice.carwash('getBookingInfo', { serviceId: detail }))
  assert.deepEqual(d.modes, ['store'])
})

test('同一时段约满后不再接受预约；上门和到店分开算', async () => {
  const at = slot(1, 0)
  const o = await ok(alice.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, payBy: 'later', plate: '川a12345' }))
  const saved = await getDoc('cw_orders', o.id)
  assert.equal(saved.plate, '川A12345')
  assert.equal(saved.payStatus, 'unpaid')
  assert.equal(saved.payMethod, 'later')
  assert.equal(saved.totalFee, 5000)
  await fails(bob.carwash('createOrder', { serviceId: detail, mode: 'store', slotStart: at, payBy: 'later' }), 'SLOT_FULL')
  info = await ok(bob.carwash('getBookingInfo', { serviceId: wash }))
  assert.deepEqual(info.days[1].slots[0].left, { store: 0, door: 1 })
  // 精洗不能上门；不在时段列表里的时间约不了
  await fails(bob.carwash('createOrder', { serviceId: detail, mode: 'door', slotStart: at, payBy: 'later' }))
  await fails(bob.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at + 60000, payBy: 'later' }), 'SLOT_GONE')
})

test('并发预约同一时段不超卖', async () => {
  const at = slot(1, 1)
  const users = ['U1', 'U2', 'U3', 'U4', 'U5'].map(inCarwash)
  const results = await Promise.all(users.map((u) => u.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, payBy: 'later' })))
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.code), ['SLOT_FULL', 'SLOT_FULL', 'SLOT_FULL', 'SLOT_FULL'])
  assert.equal((await db.collection('cw_orders').where({ slotStart: at, status: 'pending' }).count()).total, 1)
})

test('地址簿：电话、位置检查；第一个地址是默认的', async () => {
  await fails(alice.carwash('saveAddress', { address: { name: '爱丽丝', phone: '123', place: '某小区', location: NEAR } }))
  await fails(alice.carwash('saveAddress', { address: { name: '爱丽丝', phone: '13800000000', place: '某小区' } }))
  near = (await ok(alice.carwash('saveAddress', { address: { name: '爱丽丝', phone: '13800000000', place: '近的小区', detail: '3 栋 2 单元', location: NEAR } }))).id
  far = (await ok(alice.carwash('saveAddress', { address: { name: '爱丽丝', phone: '13800000000', place: '远的小区', location: FAR } }))).id
  const list = await ok(alice.carwash('listAddresses'))
  assert.equal(list.find((a) => a._id === near).isDefault, true)
  assert.equal(list.find((a) => a._id === far).isDefault, false)
  assert.deepEqual(await ok(bob.carwash('listAddresses')), [], '看不到别人的地址')
  await fails(bob.carwash('quote', { serviceId: wash, mode: 'door', addressId: near }), 'ADDRESS_NEEDED')
})

test('上门：半径内加上门费；超出半径拒绝，或者按设置加价', async () => {
  const q = await ok(alice.carwash('quote', { serviceId: wash, mode: 'door', addressId: near }))
  assert.equal(q.doorFee, 1000)
  assert.equal(q.extraFee, 0)
  assert.equal(q.totalFee, 6000)
  assert.ok(q.distanceKm < 1)
  await fails(alice.carwash('quote', { serviceId: wash, mode: 'door', addressId: far }), 'OUT_OF_RANGE')
  await fails(alice.carwash('createOrder', { serviceId: wash, mode: 'door', slotStart: slot(1, 2), addressId: far, payBy: 'later' }), 'OUT_OF_RANGE')
  await ok(saveSettings({ outOfRange: 'fee', outOfRangeFee: 2000 }))
  const q2 = await ok(alice.carwash('quote', { serviceId: wash, mode: 'door', addressId: far }))
  assert.equal(q2.extraFee, 2000)
  assert.equal(q2.totalFee, 8000)
  assert.ok(q2.distanceKm > 10)
  await ok(saveSettings({ outOfRange: 'reject', outOfRangeFee: null }))
})

test('会员价：充了送会员天数的档位后按会员价算', async () => {
  await ok(manager.carwash('saveMemberSettings', { enabled: true }))
  const plan = (await ok(manager.carwash('savePlan', { plan: { price: 30000, bonus: 10000, memberDays: 365 } }))).id
  const me = await ok(alice.carwash('getMember'))
  await ok(tech1.carwash('counterRecharge', { memberNo: me.member.memberNo, planId: plan }))
  const q = await ok(alice.carwash('quote', { serviceId: wash, mode: 'store' }))
  assert.equal(q.unitPrice, 4000)
  assert.equal(q.memberPriced, true)
  const q2 = await ok(bob.carwash('quote', { serviceId: wash, mode: 'store' }))
  assert.equal(q2.unitPrice, 5000)
})

test('技师接单 → 开始服务 → 完成 → 顾客确认；只有接单的技师能推进', async () => {
  const [order] = (await ok(tech1.carwash('staffOrders', { day: info.days[1].day, scope: 'todo' }))).orders
  assert.equal(order.serviceName, '标准洗车')
  await ok(tech1.carwash('acceptOrder', { id: order._id }))
  await fails(tech2.carwash('acceptOrder', { id: order._id }), 'ORDER_TAKEN')
  await fails(tech2.carwash('advanceOrder', { id: order._id, status: 'serving' }), 'FORBIDDEN')
  await fails(tech1.carwash('advanceOrder', { id: order._id, status: 'departed' }), 'BAD_STATUS')
  await fails(tech1.carwash('advanceOrder', { id: order._id, status: 'done' }), 'BAD_STATUS')
  await ok(tech1.carwash('advanceOrder', { id: order._id, status: 'serving' }))
  await ok(tech1.carwash('collectPay', { id: order._id }))
  await fails(tech1.carwash('collectPay', { id: order._id }))
  await ok(tech1.carwash('advanceOrder', { id: order._id, status: 'done' }))
  const mine = await ok(tech1.carwash('staffOrders', { day: info.days[1].day, scope: 'mine' }))
  assert.equal(mine.orders[0].status, 'done')
  await fails(bob.carwash('confirmDone', { id: order._id }))
  await ok(alice.carwash('confirmDone', { id: order._id }))
  const saved = await getDoc('cw_orders', order._id)
  assert.equal(saved.status, 'finished')
  assert.equal(saved.payMethod, 'counter')
  assert.equal(saved.collectedByName, '小李')
  // 技师看不到全部，店长能
  await fails(tech1.carwash('staffOrders', { scope: 'all' }), 'FORBIDDEN')
  assert.ok((await ok(manager.carwash('staffOrders', { day: info.days[1].day, scope: 'all' }))).orders.length >= 2)
})

test('上门单：店长派单，技师出发 → 服务 → 完成；超时没确认的自动完成', async () => {
  const o = await ok(alice.carwash('createOrder', { serviceId: wash, mode: 'door', slotStart: slot(1, 3), addressId: near, payBy: 'later' }))
  const saved = await getDoc('cw_orders', o.id)
  assert.equal(saved.unitPrice, 4000, '会员价')
  assert.equal(saved.totalFee, 5000)
  assert.equal(saved.address.place, '近的小区')
  assert.equal(saved.contactPhone, '13800000000')
  // 技师二看得到待接单的地址；派给技师一以后就看不到了
  const todo = await ok(tech2.carwash('staffOrders', { day: saved.slotDay, scope: 'todo' }))
  assert.equal(todo.orders.find((x) => x._id === o.id).address.place, '近的小区')
  await fails(tech1.carwash('assignOrder', { id: o.id, techId: 'TECH1' }), 'FORBIDDEN')
  await fails(manager.carwash('assignOrder', { id: o.id, techId: 'ALICE' }))
  await ok(manager.carwash('assignOrder', { id: o.id, techId: 'TECH1' }))
  const other = await ok(tech2.carwash('staffGetOrder', { id: o.id }))
  assert.equal(other.address, null)
  assert.equal(other.contactPhone, '')
  await ok(tech1.carwash('advanceOrder', { id: o.id, status: 'departed' }))
  await fails(alice.carwash('cancelOrder', { id: o.id }), 'CANCEL_NOT_ALLOWED')
  await ok(tech1.carwash('advanceOrder', { id: o.id, status: 'serving' }))
  await ok(tech1.carwash('advanceOrder', { id: o.id, status: 'done' }))
  await modules.carwash.runTimers()
  assert.equal((await getDoc('cw_orders', o.id)).status, 'done', '还没到 24 小时')
  await setDoc('cw_orders', o.id, { doneAt: new Date(Date.now() - 25 * 3600 * 1000) })
  await modules.carwash.runTimers()
  const after = await getDoc('cw_orders', o.id)
  assert.equal(after.status, 'finished')
  assert.equal(after.finishedBy, 'auto')
})

test('微信支付走洗车的商户号：付款前技师看不到，付完才出现；付款人是洗车小程序的 openid', async () => {
  state.cw.payOrders = {}
  state.payOrders = {}
  const o = await ok(carol.carwash('createOrder', { serviceId: detail, mode: 'store', slotStart: slot(2, 0), payBy: 'wechat' }))
  assert.equal(o.awaitingPay, true)
  assert.equal(o.payFee, 12000)
  let todo = await ok(tech1.carwash('staffOrders', { day: info.days[2].day, scope: 'todo' }))
  assert.equal(todo.orders.length, 0)
  const { payment } = await ok(carol.carwash('payOrder', { id: o.id }))
  assert.equal(payment.package, 'prepay_id=wx' + o.orderNo)
  const sent = state.cw.payOrders[o.orderNo].params
  assert.equal(sent.openid, 'CW_CAROL')
  assert.equal(sent.notifyPath, '/pay/notify/carwash')
  assert.equal(sent.total, 12000)
  assert.equal(Object.keys(state.payOrders).length, 0, '没走咖啡的商户号')
  // 从咖啡小程序付洗车的单不行
  await fails(as('CAROL', { app: 'coffee', appOpenid: 'CF_CAROL' }).carwash('payOrder', { id: o.id }), 'WRONG_APP')
  // 没付钱时通知来了也不算
  await modules.carwash.onPayNotify({ outTradeNo: o.orderNo })
  assert.equal((await getDoc('cw_orders', o.id)).payStatus, 'unpaid')
  state.cw.payOrders[o.orderNo].paid = true
  await modules.carwash.onPayNotify({ outTradeNo: o.orderNo })
  await modules.carwash.onPayNotify({ outTradeNo: o.orderNo })
  const saved = await getDoc('cw_orders', o.id)
  assert.equal(saved.payStatus, 'paid')
  assert.equal(saved.payMethod, 'wechat')
  assert.equal(saved.awaitingPay, false)
  todo = await ok(tech1.carwash('staffOrders', { day: info.days[2].day, scope: 'todo' }))
  assert.equal(todo.orders.length, 1)
})

test('在线付款超时没付：自动取消，名额让出来', async () => {
  const at = slot(2, 1)
  const o = await ok(bob.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, payBy: 'wechat' }))
  await fails(carol.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, payBy: 'later' }), 'SLOT_FULL')
  await setDoc('cw_orders', o.id, { createdAt: new Date(Date.now() - 20 * 60000) })
  await fails(bob.carwash('payOrder', { id: o.id }))
  const saved = await getDoc('cw_orders', o.id)
  assert.equal(saved.status, 'cancelled')
  assert.equal(saved.cancelReason, '超时未付款')
  await ok(carol.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, payBy: 'later' }))
})

test('取消：开始前 2 小时以前全额退；之后扣 10 元；设成不能取消时拦住', async () => {
  state.cw.refunds = []
  const paid = async (who, at) => {
    const o = await ok(who.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: at, payBy: 'wechat' }))
    await ok(who.carwash('payOrder', { id: o.id }))
    state.cw.payOrders[o.orderNo].paid = true
    assert.deepEqual(await ok(who.carwash('confirmPay', { id: o.id })), { payStatus: 'paid' })
    return o
  }
  const early = await paid(bob, slot(2, 2))
  const d1 = await ok(bob.carwash('getOrder', { id: early.id }))
  assert.deepEqual(d1.cancel, { allowed: true, late: false, fee: 0 })
  assert.deepEqual(await ok(bob.carwash('cancelOrder', { id: early.id })), { fee: 0 })
  assert.equal(state.cw.refunds[0].refund, 5000)
  assert.equal(state.cw.refunds[0].outRefundNo, 'R' + early.orderNo)
  assert.equal((await getDoc('cw_orders', early.id)).payStatus, 'refunded')
  await fails(bob.carwash('cancelOrder', { id: early.id }))

  const late = await paid(bob, slot(2, 3))
  await setDoc('cw_orders', late.id, { slotStart: Date.now() + 30 * 60000 })
  const d2 = await ok(bob.carwash('getOrder', { id: late.id }))
  assert.deepEqual(d2.cancel, { allowed: true, late: true, fee: 1000 })
  assert.deepEqual(await ok(bob.carwash('cancelOrder', { id: late.id })), { fee: 1000 })
  assert.equal(state.cw.refunds[1].refund, 4000)
  assert.equal(state.cw.refunds[1].total, 5000)
  const saved = await getDoc('cw_orders', late.id)
  assert.equal(saved.refundFee, 4000)
  assert.equal(saved.cancelFee, 1000)

  await ok(saveSettings({ lateCancel: 'deny' }))
  const denied = await paid(bob, slot(2, 4))
  await setDoc('cw_orders', denied.id, { slotStart: Date.now() + 30 * 60000 })
  assert.equal((await ok(bob.carwash('getOrder', { id: denied.id }))).cancel.allowed, false)
  await fails(bob.carwash('cancelOrder', { id: denied.id }), 'CANCEL_TOO_LATE')
  // 店长取消照样全额退
  await fails(tech1.carwash('staffCancelOrder', { id: denied.id, reason: '下雨' }), 'FORBIDDEN')
  await fails(manager.carwash('staffCancelOrder', { id: denied.id }))
  await ok(manager.carwash('staffCancelOrder', { id: denied.id, reason: '下雨' }))
  assert.equal(state.cw.refunds[2].refund, 5000)
  await ok(saveSettings({ lateCancel: 'fee' }))
})

test('余额付：下单时扣，取消时退回余额；余额不够下不了单', async () => {
  const before = (await getDoc('cw_members', 'ALICE')).balance
  const o = await ok(alice.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: slot(2, 5), payBy: 'balance' }))
  assert.equal((await getDoc('cw_members', 'ALICE')).balance, before - 4000)
  const saved = await getDoc('cw_orders', o.id)
  assert.equal(saved.payStatus, 'paid')
  assert.equal(saved.payMethod, 'balance')
  await ok(alice.carwash('cancelOrder', { id: o.id }))
  assert.equal((await getDoc('cw_members', 'ALICE')).balance, before)
  assert.equal((await getDoc('cw_orders', o.id)).payStatus, 'refunded')
  // 咖啡的余额没动
  assert.equal(await getDoc('members', 'ALICE').then((m) => m.balance), 0)
  await fails(bob.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: slot(2, 6), payBy: 'balance' }), 'BALANCE_LOW')
  await fails(bob.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: slot(2, 6) }))
})

test('不支持到店付款时只能在线付或用余额', async () => {
  await ok(saveSettings({ payLater: false }))
  await fails(bob.carwash('createOrder', { serviceId: wash, mode: 'store', slotStart: slot(2, 6), payBy: 'later' }), 'PAY_LATER_DISABLED')
  await ok(saveSettings({ payLater: true }))
})

test('汇总和日历', async () => {
  const day = info.days[1].day
  const cal = await ok(manager.carwash('calendar', { from: day, days: 2 }))
  assert.equal(cal.days[0].day, day)
  assert.equal(cal.days[0].capacity.store, 9)
  assert.ok(cal.days[0].store >= 2)
  const sum = await ok(manager.carwash('daySummary', { from: day, to: info.days[2].day }))
  assert.ok(sum.totals.counterFee >= 5000)
  assert.ok(sum.totals.wechatFee >= 12000)
  assert.ok(sum.totals.cancelled >= 3)
  assert.equal(sum.totals.cancelFee, 1000)
  await fails(tech1.carwash('daySummary', {}), 'FORBIDDEN')
})
