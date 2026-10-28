// 首页改版：轮播、营业时间、预约（必须先在线付款）、领券中心和代金券
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc, setDoc, modules } = require('./helpers/load')
const { reserveSlots, hoursOf, checkHours } = require('../server/functions/shop')
const { couponDiscount, pickCoupon } = require('../server/functions/pricing')
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

let menu
let shelf
const product = (name) => menu.products.find((p) => p.name === name)
const latte = () => product('拿铁')
const cake = () => product('芝士蛋糕') // 28 元
const pour = () => product('手冲') // 32 元

test('预约时间：营业时间内每 15 分钟一档，至少提前 30 分钟，今天和明天', () => {
  const hours = { open: '08:00', close: '22:00' }
  // 北京时间 10-25 14:00
  const now = Date.parse('2026-10-25T06:00:00Z')
  const slots = reserveSlots(hours, now)
  assert.equal(slots[0].label, '今天 14:30')
  assert.equal(slots[0].at, Date.parse('2026-10-25T06:30:00Z'))
  const today = slots.filter((s) => s.label.indexOf('今天') === 0)
  assert.equal(today[today.length - 1].label, '今天 21:45', '打烊那一刻不能约')
  assert.equal(today.length, 30)
  const tomorrow = slots.filter((s) => s.label.indexOf('明天') === 0)
  assert.equal(tomorrow[0].label, '明天 08:00')
  assert.equal(tomorrow[0].at, Date.parse('2026-10-26T00:00:00Z'))
  assert.equal(tomorrow.length, 56)
  // 14:05 下单，最早 14:45
  assert.equal(reserveSlots(hours, now + 5 * 60000)[0].label, '今天 14:45')
  // 打烊以后只能约明天
  assert.equal(reserveSlots(hours, Date.parse('2026-10-25T14:00:00Z'))[0].label, '明天 08:00')
})

test('营业时间：格式不对、打烊早于开门都不行；没设过用默认 8 点到 22 点', () => {
  assert.deepEqual(hoursOf({}), { open: '08:00', close: '22:00' })
  assert.deepEqual(hoursOf({ hours: { open: '09:30', close: '21:00' } }), { open: '09:30', close: '21:00' })
  assert.throws(() => checkHours({ open: '9:30', close: '21:00' }), /格式不对/)
  assert.throws(() => checkHours({ open: '21:00', close: '09:00' }), /晚于开门/)
  assert.throws(() => checkHours({ open: '24:00', close: '25:00' }), /格式不对/)
})

test('代金券怎么抵：门槛按用完赠饮券后的金额算，最多抵到 0；自动挑抵得最多的', () => {
  const c30 = { _id: 'a', amount: 500, minSpend: 3000, expiresDay: '2026-11-01' }
  const free = { _id: 'b', amount: 300, minSpend: 0, expiresDay: '2026-10-28' }
  const big = { _id: 'c', amount: 2000, minSpend: 0, expiresDay: '2026-12-01' }
  assert.equal(couponDiscount(c30, 2999), 0)
  assert.equal(couponDiscount(c30, 3000), 500)
  assert.equal(couponDiscount(free, 200), 200, '无门槛券最多抵到 0')
  assert.equal(couponDiscount(free, 0), 0)
  assert.deepEqual(pickCoupon([c30, free], 3200).coupon, c30)
  assert.deepEqual(pickCoupon([c30, free], 2800).coupon, free)
  assert.equal(pickCoupon([c30, free], 3200, '').coupon, null, "传 '' 表示不用券")
  assert.deepEqual(pickCoupon([c30, free], 3200, 'b'), { coupon: free, discount: 300 })
  assert.equal(pickCoupon([c30, free], 2800, 'a').coupon, null, '选的券不够门槛就不用')
  // 抵得一样多时挑先过期的
  const free2 = Object.assign({}, free, { _id: 'd', expiresDay: '2026-10-26' })
  assert.equal(pickCoupon([free, big, free2], 300).coupon._id, 'd')
})

test('准备：店主、咖啡师、菜单、书', async () => {
  db.reset()
  state.payReady = true
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: invite.code, name: '小林' }))
  menu = await ok(alice.coffee('getMenu'))
  shelf = await ok(alice.book('getShelf'))
})

test('首页：后台没配轮播时，自动放最近上架的商品和书', async () => {
  const home = await ok(alice.common('getHome'))
  assert.ok(home.banners.length >= 2)
  assert.ok(home.banners.some((b) => b.kind === 'product' && b.subtitle === '新品上市'))
  assert.ok(home.banners.some((b) => b.kind === 'book' && /^《.+》$/.test(b.title)))
  assert.deepEqual(home.hours, { open: '08:00', close: '22:00' })
  assert.equal(home.reserveEnabled, false, '没开微信支付不能预约')
  assert.equal(home.claimableCoupons, 0)
})

test('首页轮播：只有店主能配；指向的商品下架了顾客就看不到', async () => {
  await fails(alice.common('listBanners'), 'FORBIDDEN')
  await fails(barista.common('saveBanner', { banner: { kind: 'coupons' } }), 'FORBIDDEN')
  const options = await ok(owner.common('bannerOptions'))
  assert.ok(options.products.some((p) => p._id === latte()._id))
  assert.ok(options.books.length > 0)

  await fails(owner.common('saveBanner', { banner: { kind: 'product', targetId: 'nope' } }))
  await fails(owner.common('saveBanner', { banner: { kind: 'none' } }))
  await fails(owner.common('saveBanner', { banner: { kind: 'none', image: 'https://evil.example/a.jpg' } }))
  const p = await ok(owner.common('saveBanner', { banner: { kind: 'product', targetId: latte()._id, title: '秋季新品 桂花拿铁', image: '/uploads/banners/a.jpg' } }))
  const book = shelf.books[0]
  const b = await ok(owner.common('saveBanner', { banner: { kind: 'book', targetId: book._id } }))
  const c = await ok(owner.common('saveBanner', { banner: { kind: 'coupons', subtitle: '新人立减 5 元' } }))

  let home = await ok(alice.common('getHome'))
  assert.deepEqual(home.banners.map((x) => x._id), [p.id, b.id, c.id], '配了以后只显示配的，按顺序')
  assert.equal(home.banners[0].title, '秋季新品 桂花拿铁')
  assert.equal(home.banners[0].image, '/uploads/banners/a.jpg')
  assert.equal(home.banners[1].title, '《' + book.title + '》')
  assert.equal(home.banners[2].title, '领券中心')

  await ok(owner.common('sortBanners', { ids: [c.id, p.id, b.id] }))
  await ok(owner.common('setBannerFlags', { id: b.id, enabled: false }))
  await ok(owner.coffee('setProductFlags', { id: latte()._id, onShelf: false }))
  home = await ok(alice.common('getHome'))
  assert.deepEqual(home.banners.map((x) => x._id), [c.id], '停用的、商品下架的都不显示')
  const list = await ok(owner.common('listBanners'))
  assert.equal(list.find((x) => x._id === p.id).broken, true, '后台提示这张轮播的商品下架了')
  await ok(owner.coffee('setProductFlags', { id: latte()._id, onShelf: true }))

  // 换图、删除时把旧图删掉
  await ok(owner.common('saveBanner', { banner: { _id: p.id, kind: 'product', targetId: latte()._id, image: '/uploads/banners/b.jpg' } }))
  assert.ok(state.deleted.indexOf('/uploads/banners/a.jpg') !== -1)
  await ok(owner.common('deleteBanner', { id: p.id }))
  assert.ok(state.deleted.indexOf('/uploads/banners/b.jpg') !== -1)
  await ok(owner.common('setBannerFlags', { id: b.id, enabled: true }))
})

test('营业时间：店主在店铺设置里改，改支付开关时不会丢', async () => {
  await fails(owner.common('saveShopSettings', { payEnabled: false, hours: { open: '22:00', close: '08:00' } }))
  let s = await ok(owner.common('saveShopSettings', { payEnabled: false, hours: { open: '09:00', close: '21:30' } }))
  assert.deepEqual(s.hours, { open: '09:00', close: '21:30' })
  s = await ok(owner.common('saveShopSettings', { payEnabled: false, allowCounter: true }))
  assert.deepEqual(s.hours, { open: '09:00', close: '21:30' })
  assert.deepEqual((await ok(alice.common('getHome'))).hours, { open: '09:00', close: '21:30' })
})

let c5 // 满 30 减 5，每人 1 张，共 2 张
let c3 // 3 元无门槛，每人 2 张

test('代金券设置：只有店主能建，金额门槛要合理', async () => {
  await fails(barista.coffee('saveCoupon', { coupon: { amount: 500, validDays: 7 } }), 'FORBIDDEN')
  await fails(owner.coffee('saveCoupon', { coupon: { amount: 0, validDays: 7 } }))
  await fails(owner.coffee('saveCoupon', { coupon: { amount: 500, minSpend: 300, validDays: 7 } }), 'BAD_REQUEST')
  await fails(owner.coffee('saveCoupon', { coupon: { amount: 500, validDays: 0 } }))
  await fails(owner.coffee('saveCoupon', { coupon: { amount: 500, validDays: 7, perUser: 11 } }))
  c5 = (await ok(owner.coffee('saveCoupon', { coupon: { amount: 500, minSpend: 3000, validDays: 7, total: 2, perUser: 1 } }))).id
  c3 = (await ok(owner.coffee('saveCoupon', { coupon: { title: '新人券', amount: 300, validDays: 1, perUser: 2 } }))).id
  const list = await ok(owner.coffee('adminListCoupons'))
  assert.deepEqual(list.map((c) => c.title), ['满30减5', '新人券'], '没填名字时自动起名')
  assert.equal(list[0].claimed, 0)
  assert.equal(list[1].total, 0, '不填总数就是不限量')
})

test('领券中心：自己领，每人限领、总数领完就领不到了', async () => {
  let center = await ok(alice.coffee('couponCenter'))
  assert.equal(center.coupons.length, 2)
  assert.deepEqual(center.coupons.map((c) => [c.left, c.canClaim]), [[2, true], [null, true]])
  assert.equal((await ok(alice.common('getHome'))).claimableCoupons, 2)

  const v = await ok(alice.coffee('claimCoupon', { id: c5 }))
  assert.equal(v.type, 'cash')
  assert.equal(v.expiresDay, cnDay(Date.now() + 6 * 86400000), '有效 7 天，领取当天算第 1 天')
  await fails(alice.coffee('claimCoupon', { id: c5 }), 'COUPON_LIMIT')
  await ok(alice.coffee('claimCoupon', { id: c3 }))
  await ok(alice.coffee('claimCoupon', { id: c3 }))
  const res = await fails(alice.coffee('claimCoupon', { id: c3 }), 'COUPON_LIMIT')
  assert.match(res.msg, /每人最多领 2 张/)
  assert.equal((await ok(alice.common('getHome'))).claimableCoupons, 0)

  // 两个人同时抢最后一张，只有一个能领到
  const carol = as('CAROL')
  const results = await Promise.all([bob.coffee('claimCoupon', { id: c5 }), carol.coffee('claimCoupon', { id: c5 })])
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(results.find((r) => !r.ok).code, 'COUPON_SOLD_OUT')
  center = await ok(as('DAVE').coffee('couponCenter'))
  assert.equal(center.coupons[0].soldOut, true)
  await fails(as('DAVE').coffee('claimCoupon', { id: c5 }), 'COUPON_SOLD_OUT')

  // 总数不能改得比已领的少；停发后领不到，已经领的照样能用
  await fails(owner.coffee('saveCoupon', { coupon: { _id: c5, amount: 500, minSpend: 3000, validDays: 7, total: 1 } }))
  const list = await ok(owner.coffee('adminListCoupons'))
  assert.equal(list.find((c) => c._id === c5).claimed, 2)

  const mine = await ok(alice.coffee('myVouchers'))
  assert.equal(mine.usable.filter((x) => x.type === 'cash').length, 3)
})

test('下单用代金券：自动挑抵得最多的，也可以不用；一单只能用一张', async () => {
  // 一块蛋糕 28 元，不够满 30，只能用 3 元券
  let quote = await ok(alice.coffee('quote', { items: [{ productId: cake()._id, qty: 1 }] }))
  assert.equal(quote.coupon.title, '新人券')
  assert.equal(quote.couponFee, 300)
  assert.equal(quote.payFee, 2500)
  assert.equal(quote.coupons.length, 3)
  assert.equal(quote.coupons.find((c) => c.minSpend === 3000).discount, 0, '不够门槛的也列出来，抵 0')

  // 手冲 32 元：满 30 减 5 更划算
  quote = await ok(alice.coffee('quote', { items: [{ productId: pour()._id, qty: 1 }] }))
  assert.equal(quote.coupon.title, '满30减5')
  assert.equal(quote.payFee, 2700)
  quote = await ok(alice.coffee('quote', { items: [{ productId: pour()._id, qty: 1 }], couponId: '' }))
  assert.equal(quote.coupon, null)
  assert.equal(quote.payFee, 3200)

  const big = quote.coupons.find((c) => c.minSpend === 3000)
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }], couponId: big.id }))
  const order = await ok(alice.coffee('getOrder', { id }))
  assert.deepEqual(order.coupon, { id: big.id, title: '满30减5', discount: 500 })
  assert.equal(order.couponFee, 500)
  assert.equal(order.discountFee, 500)
  assert.equal(order.payFee, 2700)
  assert.equal((await getDoc('vouchers', big.id)).status, 'used')

  // 用过的券不能再用；别人的券也不能用
  await fails(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }], couponId: big.id }), 'VOUCHER_CHANGED')
  const small = quote.coupons.find((c) => c.minSpend === 0)
  await fails(bob.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour()._id, qty: 1 }], couponId: small.id }), 'VOUCHER_CHANGED')

  // 取消订单，券退回来
  await ok(alice.coffee('cancelOrder', { id }))
  assert.equal((await getDoc('vouchers', big.id)).status, 'unused')
})

test('代金券和赠饮券一起用：门槛按赠饮券抵完以后的金额算', async () => {
  // 给 alice 发一张今天的赠饮券（包天送的）
  await db.collection('vouchers').add({ data: { _id: 'drink-1', _openid: 'ALICE', title: '包天赠饮', productIds: [], maxFee: 0, day: cnDay(), status: 'unused', createdAt: new Date() } })
  // 蛋糕 + 手冲 = 60 元，赠饮券抵掉手冲 32，剩 28 不够满 30，只能用 3 元券
  const items = [{ productId: cake()._id, qty: 1 }, { productId: pour()._id, qty: 1 }]
  const quote = await ok(alice.coffee('quote', { items }))
  assert.equal(quote.voucherFee, 3200)
  assert.equal(quote.coupon.title, '新人券')
  assert.equal(quote.discountFee, 3500)
  assert.equal(quote.payFee, 2500)
  const big = quote.coupons.find((c) => c.minSpend === 3000)
  // 不用赠饮券的话 60 元够满 30 减 5
  const without = await ok(alice.coffee('quote', { items, noVouchers: true }))
  assert.equal(without.voucherFee, 0)
  assert.equal(without.vouchers, 1, '还是告诉顾客有几张赠饮券')
  assert.equal(without.coupon.id, big.id)
  assert.equal(without.payFee, 5500)
  await fails(alice.coffee('createOrder', { mode: 'takeaway', items, voucherIds: ['drink-1'], couponId: big.id }), 'VOUCHER_CHANGED')
  assert.equal((await getDoc('vouchers', 'drink-1')).status, 'unused', '下单失败时赠饮券退回去')
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items, voucherIds: ['drink-1'], couponId: quote.coupon.id }))
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.payFee, 2500)
  assert.equal(order.discountFee, 3500)
  await ok(barista.coffee('markPaid', { id }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'done' }))
})

test('过期的代金券用不了，在我的券里显示已过期', async () => {
  const mine = await ok(alice.coffee('myVouchers'))
  const left = mine.usable.find((x) => x.type === 'cash' && x.minSpend === 0)
  await setDoc('vouchers', left._id, { expiresDay: cnDay(Date.now() - 86400000) })
  const after = await ok(alice.coffee('myVouchers'))
  assert.equal(after.others.find((x) => x._id === left._id).status, 'expired')
  await fails(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: cake()._id, qty: 1 }], couponId: left._id }), 'VOUCHER_CHANGED')
})

// 永远有能约的时间：全天营业
async function openAllDay() {
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true, hours: { open: '00:00', close: '23:45' } }))
}

test('预约：没开微信支付时不能约', async () => {
  const quote = await ok(alice.coffee('quote', { items: [{ productId: cake()._id, qty: 1 }], reserve: true }))
  assert.equal(quote.reserve.enabled, false)
  assert.deepEqual(quote.reserve.slots, [])
  const at = reserveSlots({ open: '00:00', close: '23:45' })[0].at
  await fails(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: cake()._id, qty: 1 }], reserveAt: at }), 'RESERVE_DISABLED')
})

let reserved

test('预约：选营业时间里的一档，付完款店员才看得到', async () => {
  await openAllDay()
  assert.equal((await ok(alice.common('getHome'))).reserveEnabled, true)
  const items = [{ productId: cake()._id, qty: 1 }]
  const quote = await ok(alice.coffee('quote', { items, reserve: true }))
  assert.equal(quote.reserve.enabled, true)
  assert.ok(quote.reserve.slots.length > 0)
  assert.equal(quote.reserve.reserveAt, quote.reserve.slots[0].at, '没选时默认最早一档')
  const slot = quote.reserve.slots[quote.reserve.slots.length - 1]
  const chosen = await ok(alice.coffee('quote', { items, reserve: true, reserveAt: slot.at }))
  assert.equal(chosen.reserve.label, slot.label)

  await fails(alice.coffee('createOrder', { mode: 'takeaway', items, reserveAt: slot.at + 60000 }), 'RESERVE_SLOT')
  await fails(alice.coffee('createOrder', { mode: 'takeaway', items, reserveAt: Date.now() + 5 * 60000 }), 'RESERVE_SLOT')
  const { id } = await ok(alice.coffee('createOrder', { mode: 'dine_in', tableNo: '5', items, reserveAt: slot.at, couponId: '' }))
  reserved = id
  const order = await ok(alice.coffee('getOrder', { id }))
  assert.equal(new Date(order.reserveAt).getTime(), slot.at)
  assert.equal(order.day, cnDay(slot.at), '算在约定的那天')
  assert.equal(order.tableNo, '', '预约不带桌号')
  assert.equal(order.awaitingPay, true)
  assert.ok(order.payDeadline > Date.now())

  // 店员看不到没付款的预约单
  const list = await ok(barista.coffee('listOrders', { day: order.day }))
  assert.ok(!list.orders.some((o) => o._id === id))
  assert.ok(list.pendingIds.indexOf(id) === -1)

  // 付款时告诉微信最晚什么时候付
  await ok(alice.coffee('payOrder', { id }))
  const sent = state.payOrders[order.orderNo].params
  assert.ok(sent.timeExpire >= order.payDeadline)
  state.payOrders[order.orderNo].paid = true
  await modules.coffee.onPayNotify({ outTradeNo: order.orderNo })
  const paid = await ok(alice.coffee('getOrder', { id }))
  assert.equal(paid.payStatus, 'paid')
  assert.equal(paid.awaitingPay, false)
  assert.equal(paid.payDeadline, undefined)
  const after = await ok(barista.coffee('listOrders', { day: order.day }))
  assert.ok(after.orders.some((o) => o._id === id), '付完款店员就看到了')
})

test('预约单在后台排在约定时间前 10 分钟的位置', async () => {
  const slots = reserveSlots({ open: '00:00', close: '23:45' }).filter((s) => cnDay(s.at) === cnDay())
  if (slots.length < 2) return // 快到半夜，今天约不了了
  const items = [{ productId: cake()._id, qty: 1 }]
  // 先下一单很晚的预约（券全抵了，直接算已付）
  await db.collection('vouchers').add({ data: { _id: 'drink-2', _openid: 'BOB', title: '包天赠饮', productIds: [], maxFee: 0, day: cnDay(), status: 'unused', createdAt: new Date() } })
  const late = await ok(bob.coffee('createOrder', { mode: 'takeaway', items, voucherIds: ['drink-2'], reserveAt: slots[slots.length - 1].at }))
  const lateOrder = await getDoc('coffee_orders', late.id)
  assert.equal(lateOrder.payStatus, 'paid')
  assert.equal(lateOrder.awaitingPay, false, '券全抵了不用等付款')
  // 再来一单现场点的
  const walkIn = await ok(bob.coffee('createOrder', { mode: 'takeaway', items }))
  const list = await ok(barista.coffee('listOrders', {}))
  const ids = list.orders.map((o) => o._id)
  assert.ok(ids.indexOf(walkIn.id) < ids.indexOf(late.id), '晚上的预约排在现在点的后面')
})

test('预约单 15 分钟内没付款：自动取消，用的券退回去，店员和账上都看不到', async () => {
  // 新人券已经领满 2 张（用了一张、过期一张），领不了了；店主再发一种
  await fails(alice.coffee('claimCoupon', { id: c3 }), 'COUPON_LIMIT')
  const c2 = (await ok(owner.coffee('saveCoupon', { coupon: { title: '预约立减', amount: 200, validDays: 3 } }))).id
  await ok(alice.coffee('claimCoupon', { id: c2 }))
  const items = [{ productId: cake()._id, qty: 1 }]
  const quote = await ok(alice.coffee('quote', { items, reserve: true }))
  assert.equal(quote.coupon.title, '预约立减')
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items, reserveAt: quote.reserve.reserveAt, couponId: quote.coupon.id }))
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.awaitingPay, true)

  // 刚过 15 分钟：不能再付，但还没取消（等正在付款的人付完）
  await setDoc('coffee_orders', id, { createdAt: new Date(Date.now() - 16 * 60000) })
  await fails(alice.coffee('payOrder', { id }), 'RESERVE_EXPIRED')
  assert.equal(await modules.coffee.expireReservations(), 0)

  // 过了 17 分钟：服务器定时取消
  await setDoc('coffee_orders', id, { createdAt: new Date(Date.now() - 18 * 60000) })
  assert.equal(await modules.coffee.expireReservations(), 1)
  const cancelled = await ok(alice.coffee('getOrder', { id }))
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelReason, '超时未付款')
  assert.equal((await getDoc('vouchers', quote.coupon.id)).status, 'unused', '代金券退回去了')

  const list = await ok(barista.coffee('listOrders', { day: order.day, status: 'cancelled' }))
  assert.ok(!list.orders.some((o) => o._id === id), '店员从来不知道这单')
  const summary = await ok(owner.coffee('daySummary', { from: order.day, to: order.day }))
  assert.equal(summary.days[0].cancelled, list.counts.cancelled)
})

test('预约单超时前其实付了（通知没到）：取消前向微信查单，标成已付', async () => {
  const items = [{ productId: cake()._id, qty: 1 }]
  const quote = await ok(bob.coffee('quote', { items, reserve: true }))
  const { id } = await ok(bob.coffee('createOrder', { mode: 'takeaway', items, reserveAt: quote.reserve.reserveAt }))
  await ok(bob.coffee('payOrder', { id }))
  const order = await getDoc('coffee_orders', id)
  state.payOrders[order.orderNo].paid = true
  await setDoc('coffee_orders', id, { createdAt: new Date(Date.now() - 18 * 60000) })
  // 顾客打开订单时顺手检查
  const fresh = await ok(bob.coffee('getOrder', { id }))
  assert.equal(fresh.status, 'pending')
  assert.equal(fresh.payStatus, 'paid')
  assert.equal(fresh.awaitingPay, false)
})

test('账单：代金券抵扣单独算一列', async () => {
  const day = cnDay()
  const summary = await ok(owner.coffee('daySummary', { from: day, to: day }))
  assert.equal(summary.totals.couponsUsed >= 1, true)
  assert.equal(summary.totals.couponFee >= 300, true)
})
