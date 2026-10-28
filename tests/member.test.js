// 会员储值：充值档位、会员号、吧台代充、在线充值、余额点单和借书、会员免费看、店主调整、汇总
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc, setDoc } = require('./helpers/load')
const wallet = require('../server/functions/wallet')
const { cnDay } = require('../server/functions/base')

const owner = as('OWNER')
const alice = as('ALICE')
const bob = as('BOB')
const carol = as('CAROL')
const barista = as('BARISTA')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

const today = () => cnDay()
let menu
let plan300
let plan500
let comic
const product = (name) => menu.products.find((p) => p.name === name)
const cake = () => product('芝士蛋糕') // 28 元
const pour = () => product('手冲') // 32 元
const balanceOf = async (openid) => (await getDoc('members', openid)).balance
const logsOf = async (openid) => (await db.collection('member_logs').where({ _openid: openid }).orderBy('createdAt', 'asc').limit(100).get()).data

test('会员到期日：到期当天还算会员；再充从到期日往后加，过期了从今天算', () => {
  assert.equal(wallet.addDays('2026-10-25', 364), '2027-10-24')
  assert.equal(wallet.isMember({ memberUntil: '2026-10-25' }, '2026-10-25'), true)
  assert.equal(wallet.isMember({ memberUntil: '2026-10-24' }, '2026-10-25'), false)
  assert.equal(wallet.isMember({ memberUntil: '' }, '2026-10-25'), false)
  assert.equal(wallet.extendUntil({}, 365, '2026-10-25'), '2027-10-24', '今天算第 1 天')
  assert.equal(wallet.extendUntil({ memberUntil: '2027-10-24' }, 365, '2026-12-01'), '2028-10-23')
  assert.equal(wallet.extendUntil({ memberUntil: '2026-01-01' }, 30, '2026-10-25'), '2026-11-23')
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
  comic = await ok(owner.book('saveBook', { book: { title: '海贼王 1', author: '尾田荣一郎', category: '漫画', copies: 2 } }))
})

test('储值设置：只有店主能改；默认没开，会员免费看漫画', async () => {
  await fails(barista.member('getMemberSettings'), 'FORBIDDEN')
  await fails(alice.member('saveMemberSettings', { enabled: true }), 'FORBIDDEN')
  const s = await ok(owner.member('getMemberSettings'))
  assert.equal(s.settings.enabled, false)
  assert.deepEqual(s.settings.freeCategories, ['漫画'])
  assert.ok(s.settings.notice.indexOf('不能提现') !== -1)
  assert.ok(s.categories.indexOf('漫画') !== -1 && s.categories.indexOf('文学') !== -1, '列出书的分类给店主勾')
  const home = await ok(alice.common('getHome'))
  assert.equal(home.member, null, '没开储值时首页不显示会员卡')
})

test('充值档位：金额、赠送、会员天数检查；不填名字自动叫「充 300 送 100」', async () => {
  await fails(barista.member('savePlan', { plan: { price: 30000 } }), 'FORBIDDEN')
  await fails(owner.member('savePlan', { plan: { price: 0 } }))
  await fails(owner.member('savePlan', { plan: { price: 30000, bonus: -1 } }))
  await fails(owner.member('savePlan', { plan: { price: 30000, memberDays: 4000 } }))
  await fails(owner.member('savePlan', { plan: { price: 12.5 } }))
  plan300 = (await ok(owner.member('savePlan', { plan: { price: 30000, bonus: 10000, memberDays: 365 } }))).id
  plan500 = (await ok(owner.member('savePlan', { plan: { price: 50000, bonus: 20000, memberDays: 365 } }))).id
  const small = (await ok(owner.member('savePlan', { plan: { price: 10000, title: '充一百', enabled: false } }))).id
  const s = await ok(owner.member('getMemberSettings'))
  assert.deepEqual(s.plans.map((p) => p.title), ['充 300 送 100', '充 500 送 200', '充一百'])
  await ok(owner.member('sortPlans', { ids: [plan500, plan300, small] }))
  await ok(owner.member('deletePlan', { id: small }))
  await ok(owner.member('sortPlans', { ids: [plan300, plan500] }))
  await ok(owner.member('saveMemberSettings', { enabled: true, freeCategories: ['漫画', '漫画', ' 绘本 '], notice: '储值不退不换' }))
  const again = await ok(owner.member('getMemberSettings'))
  assert.deepEqual(again.settings.freeCategories, ['漫画', '绘本'], '去重、去空格')
  await ok(owner.member('saveMemberSettings', { enabled: true, freeCategories: ['漫画'], notice: '储值不退不换' }))
})

test('会员中心：第一次打开发会员号，从 10001 开始；只看得到上架的档位', async () => {
  const a = await ok(alice.member('getMember'))
  assert.equal(a.member.memberNo, '10001')
  assert.equal(a.member.balance, 0)
  assert.equal(a.member.isMember, false)
  assert.deepEqual(a.plans.map((p) => p.title), ['充 300 送 100', '充 500 送 200'])
  assert.equal(a.settings.notice, '储值不退不换')
  assert.equal(a.pay.enabled, false)
  assert.equal((await ok(alice.member('getMember'))).member.memberNo, '10001', '再打开还是同一个号')
  assert.equal((await ok(bob.member('getMember'))).member.memberNo, '10002')
  const home = await ok(alice.common('getHome'))
  assert.equal(home.member.enabled, true)
  assert.equal(home.member.promo, '充 300 送 100，送 365 天会员')
  assert.equal(home.reserveEnabled, true, '开了储值就能预约（用余额付）')
})

test('吧台代充：店主和咖啡师按档位充，顾客不能给自己充；记下是谁充的', async () => {
  await fails(alice.member('counterRecharge', { memberNo: '10001', planId: plan300 }), 'FORBIDDEN')
  await fails(barista.member('counterRecharge', { memberNo: '99999', planId: plan300 }), 'MEMBER_NOT_FOUND')
  await fails(barista.member('counterRecharge', { memberNo: '10001', planId: 'nope' }), 'PLAN_GONE')
  const res = await ok(barista.member('counterRecharge', { memberNo: '10001', planId: plan300 }))
  assert.equal(res.balance, 40000)
  assert.equal(res.memberUntil, wallet.addDays(today(), 364))
  const detail = await ok(barista.member('getMemberDetail', { memberNo: '10001' }))
  assert.equal(detail.member.isMember, true)
  assert.equal(detail.member.totalRecharge, 30000)
  assert.equal(detail.member.totalBonus, 10000)
  assert.equal(detail.logs[0].type, 'counter')
  assert.equal(detail.logs[0].operatorName, '小林')
  assert.equal(detail.logs[0].amount, 40000)
  assert.equal(detail.logs[0].balance, 40000)
  // 再充一次，会员从到期日往后续
  const again = await ok(owner.member('counterRecharge', { memberNo: '10001', planId: plan500 }))
  assert.equal(again.balance, 110000)
  assert.equal(again.memberUntil, wallet.addDays(today(), 729))
  // 顾客看自己的流水，看不到操作人
  const mine = await ok(alice.member('myMemberLogs'))
  assert.equal(mine.logs.length, 2)
  assert.equal(mine.logs[0].title, '充 500 送 200')
  assert.equal(mine.logs[0].typeName, '吧台充值')
  assert.equal(mine.logs[0].operatorName, undefined)
  // 下架的档位不能再充
  await ok(owner.member('setPlanFlags', { id: plan500, enabled: false }))
  await fails(barista.member('counterRecharge', { memberNo: '10001', planId: plan500 }), 'PLAN_GONE')
  await ok(owner.member('setPlanFlags', { id: plan500, enabled: true }))
})

test('后台找会员：按会员号或备注；备注店员能改', async () => {
  await ok(barista.member('setMemberRemark', { memberNo: '10002', remark: '王先生 尾号 8899' }))
  let list = await ok(barista.member('listMembers', { keyword: '8899' }))
  assert.deepEqual(list.members.map((m) => m.memberNo), ['10002'])
  list = await ok(barista.member('listMembers', { keyword: '10001' }))
  assert.deepEqual(list.members.map((m) => m.memberNo), ['10001'])
  list = await ok(barista.member('listMembers', {}))
  assert.equal(list.members[0].memberNo, '10001', '最近有变动的排前面')
  await fails(alice.member('listMembers', {}), 'FORBIDDEN')
})

test('店主调整余额：要写原因，扣不成负数；咖啡师不能调', async () => {
  await fails(barista.member('adjustMember', { memberNo: '10001', amount: -100, reason: '测试' }), 'FORBIDDEN')
  await fails(owner.member('adjustMember', { memberNo: '10001', amount: -100 }))
  await fails(owner.member('adjustMember', { memberNo: '10002', amount: -100, reason: '线下退款' }), 'BALANCE_LOW')
  await fails(owner.member('adjustMember', { memberNo: '10001', amount: 0, reason: '没变' }))
  await fails(owner.member('adjustMember', { memberNo: '10001', memberUntil: '2027/01/01', reason: '格式' }))
  const res = await ok(owner.member('adjustMember', { memberNo: '10002', amount: 500, memberUntil: wallet.addDays(today(), 6), reason: '活动补偿' }))
  assert.equal(res.balance, 500)
  const detail = await ok(owner.member('getMemberDetail', { memberNo: '10002' }))
  assert.equal(detail.member.isMember, true)
  assert.equal(detail.logs[0].title, '店主加余额，会员改到 ' + wallet.addDays(today(), 6))
  assert.equal(detail.logs[0].reason, '活动补偿')
  assert.equal(detail.logs[0].operatorName, '坤总')
  await ok(owner.member('adjustMember', { memberNo: '10002', amount: -500, memberUntil: '', reason: '线下退款' }))
  assert.equal(await balanceOf('BOB'), 0)
  assert.equal((await getDoc('members', 'BOB')).memberUntil, '')
})

test('在线充值：没开微信支付时不能充；付款后加钱加会员，通知来几次都只加一次', async () => {
  await fails(alice.member('createRecharge', { planId: plan300 }), 'PAY_DISABLED')
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true }))
  await fails(carol.member('createRecharge', { planId: 'nope' }), 'PLAN_GONE')
  const r = await ok(carol.member('createRecharge', { planId: plan300 }))
  assert.ok(r.payment.package)
  const recharge = await getDoc('member_recharges', r.id)
  assert.equal(recharge.price, 30000)
  const sent = state.payOrders[recharge.rechargeNo].params
  assert.equal(sent.total, 30000)
  assert.equal(sent.notifyPath, '/pay/notify/member')
  assert.ok(sent.timeExpire > Date.now())
  // 还没付
  assert.deepEqual(await ok(carol.member('confirmPay', { id: r.id })), { payStatus: 'unpaid' })
  assert.equal(await balanceOf('CAROL'), 0)
  state.payOrders[recharge.rechargeNo].paid = true
  const { modules } = require('./helpers/load')
  await modules.member.onPayNotify({ outTradeNo: recharge.rechargeNo })
  await modules.member.onPayNotify({ outTradeNo: recharge.rechargeNo })
  assert.deepEqual(await ok(carol.member('confirmPay', { id: r.id })), { payStatus: 'paid' })
  assert.equal(await balanceOf('CAROL'), 40000)
  const logs = await logsOf('CAROL')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].type, 'recharge')
  assert.equal(logs[0].principal, 30000)
  assert.equal((await getDoc('members', 'CAROL')).memberUntil, wallet.addDays(today(), 364))
  // 别人查不到这张充值单
  await fails(alice.member('confirmPay', { id: r.id }))
  await ok(owner.common('saveShopSettings', { payEnabled: false, allowCounter: true }))
})

test('点单用余额付：下单就扣，店员直接看到已付款；余额不够不下单、券退回', async () => {
  const before = await balanceOf('ALICE')
  const quote = await ok(alice.coffee('quote', { items: [{ productId: pour()._id, qty: 2 }] }))
  assert.deepEqual(quote.wallet, { enabled: true, balance: before, memberNo: '10001' })
  const { id } = await ok(alice.coffee('createOrder', { items: [{ productId: pour()._id, qty: 2 }], mode: 'dine_in', payBy: 'balance' }))
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.payStatus, 'paid')
  assert.equal(order.payMethod, 'balance')
  assert.equal(await balanceOf('ALICE'), before - 6400)
  const logs = await logsOf('ALICE')
  const last = logs[logs.length - 1]
  assert.equal(last.type, 'pay')
  assert.equal(last.amount, -6400)
  assert.equal(last.title, '点单 手冲 等 2 件')
  assert.equal(last.refNo, order.orderNo)
  const list = await ok(barista.coffee('listOrders', { status: 'pending' }))
  assert.ok(list.orders.some((o) => o._id === id))

  // Bob 没钱
  await fails(bob.coffee('createOrder', { items: [{ productId: cake()._id, qty: 1 }], mode: 'takeaway', payBy: 'balance' }), 'BALANCE_LOW')
  // 没会员号的人也一样
  await fails(as('DAVE').coffee('createOrder', { items: [{ productId: cake()._id, qty: 1 }], mode: 'takeaway', payBy: 'balance' }), 'BALANCE_LOW')
  const bobOrders = await ok(bob.coffee('myOrders'))
  assert.equal(bobOrders.orders.length, 0)

  // 店员取消余额付的单：钱退回余额
  await ok(barista.coffee('setOrderStatus', { id, status: 'cancelled' }))
  assert.equal(await balanceOf('ALICE'), before)
  assert.equal((await getDoc('coffee_orders', id)).payStatus, 'refunded')
  const after = await logsOf('ALICE')
  assert.equal(after[after.length - 1].type, 'refund')
  assert.equal(after[after.length - 1].amount, 6400)
})

test('先下单到吧台付的，也能在订单详情改用余额付', async () => {
  const before = await balanceOf('ALICE')
  const { id } = await ok(alice.coffee('createOrder', { items: [{ productId: cake()._id, qty: 1 }], mode: 'takeaway' }))
  const detail = await ok(alice.coffee('getOrder', { id }))
  assert.deepEqual(detail.wallet, { enabled: true, balance: before })
  await fails(bob.coffee('payWithBalance', { id }))
  assert.deepEqual(await ok(alice.coffee('payWithBalance', { id })), { payStatus: 'paid' })
  assert.equal(await balanceOf('ALICE'), before - 2800)
  await fails(alice.coffee('payWithBalance', { id }))
  assert.equal(await balanceOf('ALICE'), before - 2800, '不会扣两次')
  const paid = await ok(alice.coffee('getOrder', { id }))
  assert.equal(paid.payMethod, 'balance')
  assert.equal(paid.wallet, undefined)
})

test('两笔同时扣余额：不会扣成负数', async () => {
  await ok(owner.member('adjustMember', { memberNo: '10002', amount: 5000, reason: '测试并发' }))
  const order = () => bob.coffee('createOrder', { items: [{ productId: pour()._id, qty: 1 }], mode: 'takeaway', payBy: 'balance' })
  const results = await Promise.all([order(), order()])
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(results.find((r) => !r.ok).code, 'BALANCE_LOW')
  assert.equal(await balanceOf('BOB'), 1800)
})

test('没开微信支付也能预约：要用余额付；付完店员直接看得到', async () => {
  const items = [{ productId: cake()._id, qty: 1 }]
  const quote = await ok(alice.coffee('quote', { items, reserve: true }))
  assert.equal(quote.reserve.enabled, true)
  assert.ok(quote.reserve.slots.length)
  const reserveAt = quote.reserve.reserveAt
  await fails(alice.coffee('createOrder', { items, mode: 'takeaway', reserveAt }), 'RESERVE_DISABLED')
  await fails(bob.coffee('createOrder', { items, mode: 'takeaway', reserveAt, payBy: 'balance' }), 'BALANCE_LOW')
  const { id } = await ok(alice.coffee('createOrder', { items, mode: 'takeaway', reserveAt, payBy: 'balance' }))
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.awaitingPay, false)
  assert.equal(order.payMethod, 'balance')
  assert.equal(order.day, cnDay(reserveAt))
  const list = await ok(barista.coffee('listOrders', { status: 'pending', day: order.day }))
  assert.ok(list.orders.some((o) => o._id === id))
  // 关了储值又没微信支付，就约不了
  await ok(owner.member('saveMemberSettings', { enabled: false, freeCategories: ['漫画'], notice: '' }))
  assert.equal((await ok(alice.coffee('quote', { items, reserve: true }))).reserve.enabled, false)
  await fails(alice.coffee('createOrder', { items, mode: 'takeaway', reserveAt, payBy: 'balance' }), 'RESERVE_DISABLED')
  const home = await ok(alice.common('getHome'))
  assert.equal(home.reserveEnabled, false)
  assert.equal(home.member.enabled, false, '关了储值，有余额的人首页还能看到自己的余额')
  assert.ok(home.member.balance > 0)
  assert.equal((await ok(bob.member('getMember'))).plans.length, 0, '关了以后看不到充值档位')
  await ok(owner.member('saveMemberSettings', { enabled: true, freeCategories: ['漫画'], notice: '储值不退不换' }))
})

test('用余额付了以后微信那边又付成了：微信这笔原路退回', async () => {
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true }))
  const { id } = await ok(alice.coffee('createOrder', { items: [{ productId: cake()._id, qty: 1 }], mode: 'takeaway' }))
  await ok(alice.coffee('payOrder', { id }))
  const order = await getDoc('coffee_orders', id)
  await ok(alice.coffee('payWithBalance', { id }))
  state.payOrders[order.orderNo].paid = true
  const { modules } = require('./helpers/load')
  const refunds = state.refunds.length
  await modules.coffee.onPayNotify({ outTradeNo: order.orderNo })
  await modules.coffee.onPayNotify({ outTradeNo: order.orderNo })
  assert.equal(state.refunds.length, refunds + 1, '只退一次')
  assert.equal(state.refunds[state.refunds.length - 1].outRefundNo, 'RD' + order.orderNo)
  assert.equal((await getDoc('coffee_orders', id)).payMethod, 'balance')
  // 微信先付成了再点余额付：不扣余额
  const second = await ok(alice.coffee('createOrder', { items: [{ productId: cake()._id, qty: 1 }], mode: 'takeaway' }))
  await ok(alice.coffee('payOrder', { id: second.id }))
  const o2 = await getDoc('coffee_orders', second.id)
  state.payOrders[o2.orderNo].paid = true
  const before = await balanceOf('ALICE')
  assert.deepEqual(await ok(alice.coffee('payWithBalance', { id: second.id })), { payStatus: 'paid' })
  assert.equal(await balanceOf('ALICE'), before)
  assert.equal((await getDoc('coffee_orders', second.id)).payMethod, 'wechat')
  await ok(owner.common('saveShopSettings', { payEnabled: false, allowCounter: true }))
})

test('会员免费看漫画：不收钱、当天还；不是会员或不是漫画不行', async () => {
  const detail = await ok(alice.book('getBook', { id: comic.id }))
  assert.deepEqual(detail.member, { enabled: true, free: true, canFree: true, isMember: true, memberUntil: wallet.addDays(today(), 729), balance: await balanceOf('ALICE') })
  const bobView = await ok(bob.book('getBook', { id: comic.id }))
  assert.equal(bobView.member.free, true)
  assert.equal(bobView.member.canFree, false, 'Bob 不是会员')
  const shelf = await ok(alice.book('getShelf'))
  assert.deepEqual(shelf.memberFree, ['漫画'])
  const novel = shelf.books.find((b) => b.category === '文学')

  await fails(bob.book('createRental', { bookId: comic.id, ruleId: 'member' }), 'SHELF_CHANGED')
  await fails(alice.book('createRental', { bookId: novel._id, ruleId: 'member' }), 'SHELF_CHANGED')
  const { id } = await ok(alice.book('createRental', { bookId: comic.id, ruleId: 'member' }))
  const rental = await getDoc('book_rentals', id)
  assert.equal(rental.fee, 0)
  assert.equal(rental.payStatus, 'paid')
  assert.equal(rental.payMethod, 'member')
  assert.equal(rental.ruleName, '会员畅读')
  assert.equal(rental.member, true)
  assert.equal(rental.freeCups, 0)
  const out = await ok(owner.book('handOut', { id }))
  assert.equal(new Date(out.dueAtMs).toISOString().slice(11, 19), '15:59:59', '北京时间当天 23:59:59 到期')
  // 打烊后才还也没有超时费
  await setDoc('book_rentals', id, { dueAt: new Date(Date.now() - 3 * 3600000) })
  const back = await ok(owner.book('returnBook', { id }))
  assert.equal(back.overtimeFee, 0)
})

test('借书用余额付：租金下单就扣，包天照样送饮品；取消退回余额', async () => {
  const shelf = await ok(alice.book('getShelf'))
  const dayRule = shelf.rules.find((r) => r.type === 'day')
  const book = shelf.books.find((b) => b.title === '小王子')
  const before = await balanceOf('ALICE')
  await fails(bob.book('createRental', { bookId: book._id, ruleId: dayRule._id, payBy: 'balance' }), 'BALANCE_LOW')
  assert.equal((await ok(bob.book('getBook', { id: book._id }))).book.available, 2, '余额不够不占书')
  const { id } = await ok(alice.book('createRental', { bookId: book._id, ruleId: dayRule._id, payBy: 'balance' }))
  const rental = await getDoc('book_rentals', id)
  assert.equal(rental.payMethod, 'balance')
  assert.equal(rental.payStatus, 'paid')
  assert.equal(rental.voucherCount, 1)
  assert.equal(await balanceOf('ALICE'), before - 3900)
  const res = await ok(owner.book('adminCancelRental', { id }))
  assert.equal(res.refunded, true)
  assert.equal(await balanceOf('ALICE'), before)
  assert.equal((await getDoc('book_rentals', id)).payStatus, 'refunded')
})

test('先下单后付：租金和超时费都能用余额付', async () => {
  const shelf = await ok(alice.book('getShelf'))
  const hourly = shelf.rules.find((r) => r.type === 'hourly')
  const book = shelf.books.find((b) => b.title === '瓦尔登湖')
  const before = await balanceOf('ALICE')
  const { id } = await ok(alice.book('createRental', { bookId: book._id, ruleId: hourly._id, hours: 2 }))
  const detail = await ok(alice.book('getRental', { id }))
  assert.equal(detail.wallet.balance, before)
  assert.deepEqual(await ok(alice.book('payRentalWithBalance', { id })), { payStatus: 'paid' })
  await fails(alice.book('payRentalWithBalance', { id }))
  assert.equal(await balanceOf('ALICE'), before - 1600)
  await ok(owner.book('handOut', { id }))
  await setDoc('book_rentals', id, { dueAt: new Date(Date.now() - 70 * 60000) })
  const back = await ok(owner.book('returnBook', { id }))
  assert.equal(back.overtimeFee, 1600)
  assert.deepEqual(await ok(alice.book('payRentalWithBalance', { id, kind: 'overtime' })), { overtimePayStatus: 'paid' })
  await fails(alice.book('payRentalWithBalance', { id, kind: 'overtime' }))
  assert.equal(await balanceOf('ALICE'), before - 3200)
  const r = await getDoc('book_rentals', id)
  assert.equal(r.overtimePayMethod, 'balance')
})

test('汇总：充值本金、赠送、余额消费分开算；大家手里还有多少余额', async () => {
  const s = await ok(owner.member('memberSummary', {}))
  const t = s.totals
  assert.equal(t.counterFee, 80000, '吧台充了 300 + 500')
  assert.equal(t.onlineFee, 30000, '在线充了 300')
  assert.equal(t.bonusFee, 40000)
  assert.equal(t.recharges, 3)
  const members = (await db.collection('members').limit(100).get()).data
  assert.equal(s.balanceTotal, members.reduce((n, m) => n + m.balance, 0))
  assert.equal(s.memberCount, 2, 'Alice 和 Carol 是会员')
  // 余额 = 充值本金 + 赠送 - 消费 + 退回 + 调整
  assert.equal(s.balanceTotal, t.counterFee + t.onlineFee + t.bonusFee - t.spentFee + t.refundFee + t.adjustFee)
  await fails(barista.member('memberSummary', {}), 'FORBIDDEN')

  const coffee = await ok(owner.coffee('daySummary', {}))
  assert.ok(coffee.totals.balanceFee > 0)
  assert.equal(coffee.totals.paidFee, coffee.totals.wechatFee + coffee.totals.counterFee + coffee.totals.balanceFee)
  const book = await ok(owner.book('daySummary', {}))
  assert.equal(book.totals.memberRentals, 1)
  assert.equal(book.totals.balanceFee, 1600)
  assert.equal(book.totals.overtimeBalance, 1600)
})
