// 外送（配送到家）：后台设置和配送费、收货地址、外送下单（必须在线付）、店员自己送、微信同城配送叫骑手和进度、取消、对账
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { db, state, as, unwrap, getDoc, setDoc, courierStatus, modules } = require('./helpers/load')
const delivery = require('../server/functions/delivery')
const { cnDay } = require('../server/functions/base')

const owner = as('OWNER')
const alice = as('ALICE')
const bob = as('BOB')
const barista = as('BARISTA')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

// 店在内江东兴区附近；往北 0.009 度大约 1 公里
const SHOP = { lat: 29.58, lng: 105.07 }
const near = (km) => ({ lat: Math.round((SHOP.lat + km * 0.009) * 1e6) / 1e6, lng: SHOP.lng })
// 测试不管几点跑都在外送时间里
const ALL_DAY = { open: '00:00', close: '23:59' }
const SETTINGS = {
  enabled: true,
  location: SHOP,
  store: { name: '进山咖啡', province: '四川省', city: '内江市', area: '东兴区', street: '', house: '某某路 1 号', phone: '13800000000' },
  hours: ALL_DAY,
  radiusKm: 5,
  minOrder: 2000,
  baseFee: 500,
  baseKm: 3,
  perKmFee: 200,
  freeAbove: 10000,
  etaMinutes: 40,
  notice: '超出范围可以到店自取',
  provider: 'self'
}

let menu
const product = (name) => menu.products.find((p) => p.name === name)
const latte = () => product('拿铁') // 22 元，有规格
const pour = () => product('手冲') // 32 元
const cake = () => product('芝士蛋糕') // 28 元
const pourItems = (qty) => [{ productId: pour()._id, qty: qty || 1 }]

async function addAddress(who, km, extra) {
  return (await ok(who.coffee('saveAddress', { address: Object.assign({ name: '爱丽丝', phone: '13900000000', place: '东兴小区', detail: '3 栋 2 单元 501', location: near(km) }, extra || {}) }))).id
}

async function balanceOf(openid) {
  const res = await db.collection('members').where({ _id: openid }).limit(1).get()
  return res.data[0] ? res.data[0].balance : 0
}

// 用余额下一个外送单（店员马上能看到）
async function balanceOrder(who, addressId, items) {
  return (await ok(who.coffee('createOrder', { mode: 'delivery', items: items || pourItems(), addressId, payBy: 'balance' }))).id
}

test('配送费：起步距离内收起步价，超出部分每公里加收（不足 1 公里按 1 公里），商品满额免配送费', () => {
  const s = { baseFee: 500, baseKm: 3, perKmFee: 200, freeAbove: 10000 }
  assert.equal(delivery.feeFor(s, 2.9, 3000), 500)
  assert.equal(delivery.feeFor(s, 3, 3000), 500)
  assert.equal(delivery.feeFor(s, 3.1, 3000), 700)
  assert.equal(delivery.feeFor(s, 4, 3000), 700)
  assert.equal(delivery.feeFor(s, 4.2, 3000), 900)
  assert.equal(delivery.feeFor(s, 4.2, 10000), 0, '满 100 免配送费')
  assert.equal(delivery.feeFor({ baseFee: 600, baseKm: null, perKmFee: null, freeAbove: 0 }, 4.8, 3000), 600, '不按公里加收就是一口价')
  assert.equal(delivery.feeFor({ baseFee: 0, baseKm: null, perKmFee: 0, freeAbove: null }, 1, 100), 0, '不收配送费')
})

test('外送时间：开始那一刻能下单，结束那一刻不能（按北京时间）', () => {
  const hours = { open: '10:00', close: '21:00' }
  assert.equal(delivery.inHours(hours, Date.parse('2026-10-29T02:00:00Z')), true, '北京时间 10:00')
  assert.equal(delivery.inHours(hours, Date.parse('2026-10-29T01:59:00Z')), false)
  assert.equal(delivery.inHours(hours, Date.parse('2026-10-29T12:59:00Z')), true, '20:59')
  assert.equal(delivery.inHours(hours, Date.parse('2026-10-29T13:00:00Z')), false, '21:00')
})

test('后台设置：格式检查；没填齐不开放，列出还差什么', () => {
  assert.throws(() => delivery.cleanSettings({ radiusKm: 0 }), /配送范围/)
  assert.throws(() => delivery.cleanSettings({ baseFee: 12.5 }), /配送费/)
  assert.throws(() => delivery.cleanSettings({ etaMinutes: 1 }), /预计送达/)
  assert.throws(() => delivery.cleanSettings({ hours: { open: '21:00', close: '10:00' } }), /晚于/)
  assert.throws(() => delivery.cleanSettings({ store: { phone: '123' } }), /电话/)
  assert.throws(() => delivery.cleanSettings({ provider: 'meituan' }), /配送方式/)
  assert.throws(() => delivery.cleanSettings({ wechatPattern: 'prefer' }), /哪一家/)
  const empty = delivery.cleanSettings({})
  assert.equal(empty.enabled, false)
  assert.equal(empty.provider, 'self')
  assert.equal(empty.wechatPattern, 'price')
  const list = delivery.problems(Object.assign(empty, { wechatStoreId: '' }), { online: false }, true)
  assert.deepEqual(list, ['店的位置（算距离用）', '配送范围', '起送价（不限填 0）', '配送费（不收填 0）', '在线收款：外送要先付款，先打开微信支付或会员储值'])
})

test('准备：店主、咖啡师、菜单；没开外送时首页和结算页都显示没开放', async () => {
  db.reset()
  state.payReady = true
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.coffee('seedDemo'))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: invite.code, name: '小林' }))
  menu = await ok(alice.coffee('getMenu'))
  const home = await ok(alice.common('getHome'))
  assert.equal(home.delivery.enabled, false)
  const quote = await ok(alice.coffee('quote', { items: pourItems(), delivery: true }))
  assert.equal(quote.delivery.enabled, false)
  assert.equal(quote.delivery.address, null)
  assert.equal(quote.notifyTemplate, '', '外送单不问取餐通知')
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: pourItems() }), 'DELIVERY_CLOSED')
})

test('收货地址：第一个自动设为默认，只有一个默认；电话、位置要对；只能改删自己的', async () => {
  await fails(alice.coffee('saveAddress', { address: { name: '爱丽丝', phone: '123', place: 'x', location: near(1) } }))
  await fails(alice.coffee('saveAddress', { address: { name: '爱丽丝', phone: '13900000000', place: 'x' } }))
  const a1 = await addAddress(alice, 1)
  const a2 = await addAddress(alice, 4, { place: '远一点的小区' })
  let list = await ok(alice.coffee('listAddresses'))
  assert.equal(list.length, 2)
  assert.equal(list.find((a) => a._id === a1).isDefault, true)
  await ok(alice.coffee('saveAddress', { address: Object.assign({}, list.find((a) => a._id === a2), { isDefault: true }) }))
  list = await ok(alice.coffee('listAddresses'))
  assert.deepEqual(list.filter((a) => a.isDefault).map((a) => a._id), [a2])
  assert.deepEqual(await ok(bob.coffee('listAddresses')), [])
  await fails(bob.coffee('saveAddress', { address: Object.assign({}, list[0], { name: '鲍勃' }) }))
  await ok(bob.coffee('deleteAddress', { id: a1 }))
  assert.equal((await ok(alice.coffee('listAddresses'))).length, 2, '删不了别人的')
  // 洗车的地址簿是另一本
  assert.deepEqual(await ok(alice.carwash('listAddresses')), [])
})

test('店主填外送设置：顾客和咖啡师改不了；储值没开、没微信支付时还差在线收款', async () => {
  await fails(barista.coffee('saveDeliverySettings', { settings: SETTINGS }), 'FORBIDDEN')
  await fails(alice.coffee('getDeliverySettings'), 'FORBIDDEN')
  const view = await ok(owner.coffee('saveDeliverySettings', { settings: SETTINGS }))
  assert.equal(view.settings.radiusKm, 5)
  assert.deepEqual(view.problems, ['在线收款：外送要先付款，先打开微信支付或会员储值'])
  assert.equal(view.open, false)
  assert.equal(view.wechat.ready, true)
  await ok(owner.member('saveMemberSettings', { enabled: true, freeCategories: [], notice: '' }))
  const again = await ok(owner.coffee('getDeliverySettings'))
  assert.deepEqual(again.problems, [])
  assert.equal(again.open, true)
  assert.deepEqual(again.hours, ALL_DAY)
  const home = await ok(alice.common('getHome'))
  assert.equal(home.delivery.enabled, true)
  assert.equal(home.delivery.minOrder, 2000)
})

test('结算页算价：默认地址、距离、配送费、起送价；换地址重新算；超出范围给原因', async () => {
  const list = await ok(alice.coffee('listAddresses'))
  const nearId = list.find((a) => a.place === '东兴小区')._id
  const farId = list.find((a) => a.place === '远一点的小区')._id
  // 默认地址是 4 公里那个：起步 3 公里 5 元，超出 1 公里加 2 元
  let quote = await ok(alice.coffee('quote', { items: pourItems(), delivery: true }))
  assert.equal(quote.delivery.enabled, true)
  assert.equal(quote.delivery.address._id, farId)
  assert.equal(quote.delivery.distanceKm, 4)
  assert.equal(quote.delivery.fee, 700)
  assert.equal(quote.deliveryFee, 700)
  assert.equal(quote.payFee, 3200 + 700)
  assert.equal(quote.delivery.short, 0)
  assert.equal(quote.delivery.rules.etaMinutes, 40)
  // 换近的地址
  quote = await ok(alice.coffee('quote', { items: pourItems(), delivery: true, addressId: nearId }))
  assert.equal(quote.delivery.fee, 500)
  assert.equal(quote.payFee, 3700)
  // 不够起送价
  quote = await ok(alice.coffee('quote', { items: [{ productId: product('美式')._id, qty: 1, specs: [{ name: '杯型', option: '中杯' }, { name: '温度', option: '热' }] }], delivery: true, addressId: nearId }))
  assert.equal(quote.delivery.short, 200, '18 元，差 2 元起送')
  // 满 100 免配送费
  quote = await ok(alice.coffee('quote', { items: pourItems(4), delivery: true, addressId: farId }))
  assert.equal(quote.delivery.fee, 0)
  assert.equal(quote.payFee, 12800)
  // 超出范围
  const tooFar = await addAddress(alice, 6, { place: '城外' })
  quote = await ok(alice.coffee('quote', { items: pourItems(), delivery: true, addressId: tooFar }))
  assert.equal(quote.delivery.errorCode, 'OUT_OF_RANGE')
  assert.match(quote.delivery.error, /超出了外送范围/)
  assert.equal(quote.deliveryFee, 0)
  // 不是外送时没有配送这一项
  assert.equal((await ok(alice.coffee('quote', { items: pourItems() }))).delivery, null)
})

test('外送下单：要选地址、够起送价、在范围里；没开微信支付时只能用余额付', async () => {
  const list = await ok(alice.coffee('listAddresses'))
  const nearId = list.find((a) => a.place === '东兴小区')._id
  const tooFar = list.find((a) => a.place === '城外')._id
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: pourItems() }), 'ADDRESS_NEEDED')
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: pourItems(), addressId: 'nope' }), 'ADDRESS_NEEDED')
  await fails(bob.coffee('createOrder', { mode: 'delivery', items: pourItems(), addressId: nearId }), 'ADDRESS_NEEDED')
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: pourItems(), addressId: tooFar }), 'OUT_OF_RANGE')
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: [{ productId: product('柠檬茶')._id, qty: 1, specs: [{ name: '糖度', option: '少糖' }] }], addressId: nearId }), 'DELIVERY_MIN')
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: pourItems(), addressId: nearId, reserveAt: Date.now() + 3600000 }), 'DELIVERY_CLOSED')
  // 没开微信支付（服务器配了商户号但店主没打开）：不能到吧台付
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: pourItems(), addressId: nearId }), 'DELIVERY_PAY')
  // 余额不够
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: pourItems(), addressId: nearId, payBy: 'balance' }), 'BALANCE_LOW')
})

test('用余额付的外送单：下单就扣钱（含配送费），店员马上看到地址；顾客看不到运费', async () => {
  const me = await ok(alice.member('getMember'))
  await ok(owner.member('adjustMember', { memberNo: me.member.memberNo, amount: 50000, reason: '测试充值' }))
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const before = await balanceOf('ALICE')
  const id = await balanceOrder(alice, nearId)
  assert.equal(await balanceOf('ALICE'), before - 3700)
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.mode, 'delivery')
  assert.equal(order.payStatus, 'paid')
  assert.equal(order.payMethod, 'balance')
  assert.equal(order.deliveryFee, 500)
  assert.equal(order.payFee, 3700)
  assert.equal(order.totalFee, 3200, '商品合计不含配送费')
  assert.equal(order.tableNo, '')
  assert.equal(order.delivery.status, 'waiting')
  assert.equal(order.delivery.address.detail, '3 栋 2 单元 501')
  assert.equal(order.delivery.distanceKm, 1)
  const list = await ok(barista.coffee('listOrders', { status: 'pending' }))
  const row = list.orders.find((o) => o._id === id)
  assert.equal(row.delivery.statusText, '待配送')
  assert.equal(row.delivery.address.phone, '13900000000')
  // 地址簿里改了，订单上的不变
  await ok(alice.coffee('saveAddress', { address: Object.assign({}, (await ok(alice.coffee('listAddresses'))).find((a) => a._id === nearId), { detail: '换了' }) }))
  assert.equal((await getDoc('coffee_orders', id)).delivery.address.detail, '3 栋 2 单元 501')
  const mine = await ok(alice.coffee('getOrder', { id }))
  assert.equal(mine.shopPhone, '13800000000')
  assert.equal(mine.delivery.courierFee, undefined)
})

test('店员自己送：送出时订单自动算出餐、给星；点已送达；不能重复送', async () => {
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const id = await balanceOrder(alice, nearId)
  await fails(alice.coffee('callCourier', { id, provider: 'self' }), 'FORBIDDEN')
  await fails(barista.coffee('markDelivered', { id }), 'DELIVERY_CHANGED')
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  assert.equal((await getDoc('coffee_orders', id)).delivery.status, 'waiting', '店员自己送不会自动叫骑手')
  const out = await ok(barista.coffee('callCourier', { id, provider: 'self' }))
  assert.equal(out.delivery.status, 'delivering')
  assert.equal(out.delivery.provider, 'self')
  assert.equal(out.status, 'done', '东西出门了就是已完成')
  await fails(barista.coffee('callCourier', { id, provider: 'self' }), 'DELIVERY_CHANGED')
  const done = await ok(barista.coffee('markDelivered', { id }))
  assert.equal(done.delivery.status, 'delivered')
  assert.ok(done.delivery.deliveredAt)
  const mine = await ok(alice.coffee('getOrder', { id }))
  assert.deepEqual(mine.delivery.log.map((l) => l.text), ['配送中', '已送达'])
})

test('微信同城配送：没开通门店不能叫；店里信息不全开通不了；开通后记下门店编号', async () => {
  const view = await ok(owner.coffee('saveDeliverySettings', { settings: Object.assign({}, SETTINGS, { provider: 'wechat' }) }))
  assert.deepEqual(view.problems, ['在微信同城配送开通门店（下面「微信同城配送」里点开通）'])
  assert.equal(view.open, false, '没开通门店前外送先不开放')
  assert.equal((await ok(barista.coffee('listOrders', { status: 'pending' }))).courier.ready, false, '店员这边先不显示叫骑手')
  await ok(owner.coffee('saveDeliverySettings', { settings: Object.assign({}, SETTINGS, { provider: 'wechat', store: Object.assign({}, SETTINGS.store, { house: '' }) }) }))
  await fails(owner.coffee('setupWechatStore'))
  await fails(barista.coffee('setupWechatStore'), 'FORBIDDEN')
  await ok(owner.coffee('saveDeliverySettings', { settings: Object.assign({}, SETTINGS, { provider: 'wechat', wechatPattern: 'prefer', wechatPrefer: 'SFTC' }) }))
  const opened = await ok(owner.coffee('setupWechatStore'))
  assert.equal(opened.settings.wechatStoreId, 'WXSTORE1')
  assert.equal(opened.open, true)
  const store = state.courier.stores[0]
  assert.equal(store.out_store_id, 'jinshan-coffee')
  assert.equal(store.order_pattern, 2)
  assert.equal(store.service_trans_prefer, 'SFTC')
  assert.equal(store.address_info.city, '内江市')
  assert.equal(store.address_info.lat, SHOP.lat)
  // 改了派单方式，保存时同步到微信的门店；门店编号不会被表单冲掉
  const saved = await ok(owner.coffee('saveDeliverySettings', { settings: Object.assign({}, SETTINGS, { provider: 'wechat', wechatPattern: 'price', wechatStoreId: 'hack' }) }))
  assert.equal(saved.settings.wechatStoreId, 'WXSTORE1')
  assert.equal(state.courier.stores[0].order_pattern, 1)
  assert.equal(state.courier.stores.length, 1, '再点开通是更新，不会重复建门店')
  await ok(owner.coffee('setupWechatStore'))
  assert.equal(state.courier.stores.length, 1)
  const list = await ok(barista.coffee('listOrders', { status: 'pending' }))
  assert.deepEqual(list.courier, { provider: 'wechat', name: '微信同城配送', external: true, ready: true, sandbox: false })
})

let wxOrder
test('叫骑手：先估运费，叫了以后等接单；同一单不会叫两次', async () => {
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  wxOrder = await balanceOrder(alice, nearId)
  const est = await ok(barista.coffee('courierQuote', { id: wxOrder }))
  assert.equal(est.fee, 850)
  assert.equal(est.carrierName, '达达')
  const called = await ok(barista.coffee('callCourier', { id: wxOrder }))
  assert.equal(called.delivery.status, 'calling')
  assert.equal(called.delivery.provider, 'wechat')
  assert.equal(called.delivery.courierFee, 850)
  assert.equal(called.status, 'pending', '叫了骑手不代表出餐了')
  const order = await getDoc('coffee_orders', wxOrder)
  assert.equal(order.delivery.storeOrderId, order.orderNo)
  const sent = state.courier.orders[order.orderNo].body
  assert.equal(sent.wx_store_id, 'WXSTORE1')
  assert.equal(sent.user_openid, 'ALICE')
  assert.equal(sent.user_phone, '13900000000')
  assert.equal(sent.user_address, '东兴小区 换了')
  assert.equal(sent.order_seq, order.pickupNo)
  assert.equal(sent.cargo.cargo_price, 3200)
  assert.equal(sent.cargo.cargo_type, 32)
  assert.equal(sent.order_detail_path, 'pages/order-detail/order-detail?id=' + wxOrder)
  assert.equal(sent.use_sandbox, undefined, '正式版不用沙箱')
  await fails(barista.coffee('callCourier', { id: wxOrder }), 'DELIVERY_CHANGED')
  assert.equal(Object.keys(state.courier.orders).length, 1)
})

test('配送进度：服务器每分钟查一次；骑手接单、取货（自动算出餐、给星）、送达', async () => {
  const order = await getDoc('coffee_orders', wxOrder)
  assert.equal(await modules.coffee.syncDeliveries(), 0, '没变化')
  courierStatus(order.orderNo, 30000, { name: '王师傅', phone: '13700000000' })
  assert.equal(await modules.coffee.syncDeliveries(), 1)
  let now = await ok(alice.coffee('getOrder', { id: wxOrder }))
  assert.equal(now.delivery.status, 'accepted')
  assert.deepEqual(now.delivery.rider, { name: '王师傅', phone: '13700000000' })
  assert.equal(now.delivery.carrierName, '达达')
  courierStatus(order.orderNo, 50000)
  await modules.coffee.syncDeliveries()
  now = await ok(alice.coffee('getOrder', { id: wxOrder }))
  assert.equal(now.delivery.status, 'delivering')
  assert.equal(now.status, 'done', '骑手取走了就算出餐')
  courierStatus(order.orderNo, 70000)
  await modules.coffee.syncDeliveries()
  now = await ok(alice.coffee('getOrder', { id: wxOrder }))
  assert.equal(now.delivery.status, 'delivered')
  assert.deepEqual(now.delivery.log.map((l) => l.status), ['calling', 'accepted', 'delivering', 'delivered'])
  assert.equal(await modules.coffee.syncDeliveries(), 0, '送到了就不查了')
})

test('没人接单：取消配送再重新叫（换一个门店订单号），也能改成店员送', async () => {
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const id = await balanceOrder(alice, nearId)
  await ok(barista.coffee('callCourier', { id }))
  const order = await getDoc('coffee_orders', id)
  const cancelled = await ok(barista.coffee('cancelCourier', { id }))
  assert.equal(cancelled.delivery.status, 'cancelled')
  assert.equal(cancelled.status, 'pending', '订单本身不取消')
  const again = await ok(barista.coffee('callCourier', { id }))
  assert.equal(again.delivery.status, 'calling')
  assert.equal(again.delivery.storeOrderId, order.orderNo + '-2')
  // 骑手接单后再取消，配送公司扣违约金
  courierStatus(order.orderNo + '-2', 30000, { name: '李师傅', phone: '13600000000' })
  await ok(barista.coffee('refreshCourier', { id }))
  state.courier.deductFee = 200
  const second = await ok(barista.coffee('cancelCourier', { id }))
  state.courier.deductFee = 0
  assert.equal(second.delivery.deductTotal, 200)
  assert.equal(second.delivery.rider, null)
  assert.match(second.delivery.note, /违约金/)
  const self = await ok(barista.coffee('callCourier', { id, provider: 'self' }))
  assert.equal(self.delivery.status, 'delivering')
  assert.equal(self.delivery.deductTotal, 200, '违约金记着，对账用')
  await ok(barista.coffee('markDelivered', { id }))
})

test('取消外送单：先取消骑手，再把余额退回去；取消骑手失败就不取消订单', async () => {
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const before = await balanceOf('ALICE')
  const id = await balanceOrder(alice, nearId)
  await ok(barista.coffee('callCourier', { id }))
  state.courier.fail = 9300510
  await fails(barista.coffee('setOrderStatus', { id, status: 'cancelled' }), 'COURIER_FAILED')
  assert.equal((await getDoc('coffee_orders', id)).status, 'pending')
  assert.equal(await balanceOf('ALICE'), before - 3700)
  await ok(barista.coffee('setOrderStatus', { id, status: 'cancelled' }))
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.delivery.status, 'cancelled')
  assert.equal(order.payStatus, 'refunded')
  assert.equal(await balanceOf('ALICE'), before, '配送费也退了')
  assert.ok(state.courier.calls.some((c) => c.name === 'cancelorder' && c.body.wx_order_id === 'WX' + order.orderNo))
})

test('开始制作时自动叫骑手（设置里打开了）；叫不到不影响制作，原因记在订单上', async () => {
  await ok(owner.coffee('saveDeliverySettings', { settings: Object.assign({}, SETTINGS, { provider: 'wechat', autoCall: true }) }))
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const id = await balanceOrder(alice, nearId)
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  assert.equal((await getDoc('coffee_orders', id)).delivery.status, 'calling')
  const id2 = await balanceOrder(alice, nearId)
  state.courier.fail = 9300506
  await ok(barista.coffee('setOrderStatus', { id: id2, status: 'making' }))
  const o2 = await getDoc('coffee_orders', id2)
  assert.equal(o2.status, 'making')
  assert.equal(o2.delivery.status, 'waiting')
  assert.match(o2.delivery.error, /叫骑手失败/)
  const retried = await ok(barista.coffee('callCourier', { id: id2 }))
  assert.equal(retried.delivery.status, 'calling')
  assert.equal(retried.delivery.error, '')
  await ok(owner.coffee('saveDeliverySettings', { settings: Object.assign({}, SETTINGS, { provider: 'wechat' }) }))
})

test('配送状态回调：签名对了才认；重新叫过骑手的，旧单的回调不管', async () => {
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const id = await balanceOrder(alice, nearId)
  await ok(barista.coffee('callCourier', { id }))
  const order = await getDoc('coffee_orders', id)
  const sign = (body) => {
    const pairs = Object.keys(body).map((k) => k + '=' + body[k]).sort()
    return Object.assign({}, body, { sign: crypto.createHash('md5').update(pairs.join('&') + '&token=TOKEN').digest('hex') })
  }
  const body = { appid: 'wx1', wx_store_id: 'WXSTORE1', wx_order_id: 'WX' + order.orderNo, store_order_id: order.orderNo, order_status: 30000, status_change_time: 1, timestamp: 2, service_trans_id: 'DADA' }
  assert.equal(await modules.coffee.onCourierNotify(Object.assign({}, body, { sign: 'bad' })), false)
  assert.equal(await modules.coffee.onCourierNotify(sign(Object.assign({}, body, { order_status: 50000 }))), true)
  assert.equal((await getDoc('coffee_orders', id)).delivery.status, 'delivering')
  // 旧的门店订单号
  assert.equal(await modules.coffee.onCourierNotify(sign(Object.assign({}, body, { store_order_id: order.orderNo + '-9', order_status: 20001 }))), true)
  assert.equal((await getDoc('coffee_orders', id)).delivery.status, 'delivering')
  assert.equal(await modules.coffee.onCourierNotify(sign(Object.assign({}, body, { order_status: 70000 }))), true)
  assert.equal((await getDoc('coffee_orders', id)).delivery.status, 'delivered')
})

test('沙箱（测试版）：叫的是测试单，能模拟骑手；正式单不能模拟', async () => {
  await fails(barista.coffee('mockCourier', { id: wxOrder, status: 'accepted' }))
  state.courier.sandbox = true
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const id = await balanceOrder(alice, nearId)
  const called = await ok(barista.coffee('callCourier', { id }))
  assert.equal(called.delivery.sandbox, true)
  const order = await getDoc('coffee_orders', id)
  assert.equal(state.courier.orders[order.orderNo].body.use_sandbox, 1)
  const mocked = await ok(barista.coffee('mockCourier', { id, status: 'accepted' }))
  assert.equal(mocked.delivery.status, 'accepted')
  assert.ok(state.courier.calls.some((c) => c.name === 'mocknotify' && c.body.order_status === 30000))
  state.courier.sandbox = false
})

test('外送单用微信付：付款前店员看不到，15 分钟不付自动取消', async () => {
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true }))
  const nearId = (await ok(alice.coffee('listAddresses'))).find((a) => a.place === '东兴小区')._id
  const quote = await ok(alice.coffee('quote', { items: pourItems(), delivery: true, addressId: nearId }))
  assert.equal(quote.pay.allowCounter, true, '店里允许吧台付，外送页面自己不给选')
  const { id } = await ok(alice.coffee('createOrder', { mode: 'delivery', items: pourItems(), addressId: nearId }))
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.awaitingPay, true)
  assert.equal(order.payStatus, 'unpaid')
  const list = await ok(barista.coffee('listOrders', { status: 'pending' }))
  assert.ok(!list.orders.some((o) => o._id === id), '没付款店员看不到')
  await fails(barista.coffee('callCourier', { id }))
  const payment = await ok(alice.coffee('payOrder', { id }))
  assert.ok(payment.payment.package)
  assert.equal(state.payOrders[order.orderNo].params.total, 3700, '微信付的钱含配送费')
  await setDoc('coffee_orders', id, { createdAt: new Date(Date.now() - 18 * 60000) })
  assert.equal(await modules.coffee.expireReservations(), 1)
  assert.equal((await getDoc('coffee_orders', id)).cancelReason, '超时未付款')
  await ok(owner.common('saveShopSettings', { payEnabled: false, allowCounter: true }))
})

test('充运费和查余额：只有店主能用', async () => {
  state.courier.balance = [{ service_trans_id: 'DADA', balance: 5000 }]
  const list = await ok(owner.coffee('courierBalance'))
  assert.deepEqual(list, [{ carrier: 'DADA', carrierName: '达达', balance: 5000 }])
  await fails(barista.coffee('courierBalance'), 'FORBIDDEN')
  await fails(owner.coffee('courierCharge', { carrier: 'DADA', amount: 1000 }))
  await fails(owner.coffee('courierCharge', { carrier: 'XX', amount: 5000 }))
  const res = await ok(owner.coffee('courierCharge', { carrier: 'SFTC', amount: 5000 }))
  assert.match(res.payurl, /^https:/)
})

test('每日汇总：外送单数、顾客付的配送费、付给配送公司的运费和违约金', async () => {
  const day = cnDay()
  const summary = await ok(owner.coffee('daySummary', { from: day, to: day }))
  const t = summary.totals
  // 没取消的外送单：没送的 1 单、自己送 2 单（其中 1 单先叫过骑手扣了违约金）、骑手送到 2 单、自动叫的 2 单、沙箱 1 单；另有 1 单付了钱又取消（没付款超时取消的不算）
  assert.equal(t.deliveryOrders, 8)
  assert.equal(t.deliveryFee, 8 * 500)
  // 有运费的：骑手送到的 2 单、自动叫的 2 单、沙箱 1 单，各 8.5 元；违约金 2 元
  assert.equal(t.courierFee, 5 * 850 + 200)
  assert.equal(t.cancelled, 1)
})
