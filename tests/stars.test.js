// 集星：后台配规则、出餐收款后给星、下单用星换一杯、取消退回、过期、店主加减星、汇总
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, as, unwrap, getDoc, setDoc } = require('./helpers/load')
const stars = require('../server/functions/stars')
const wallet = require('../server/functions/wallet')
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
let coffeeCat
let dessertCat
const product = (name) => menu.products.find((p) => p.name === name)
const item = (name, qty) => ({ productId: product(name)._id, qty: qty || 1, specs: (product(name).specs || []).map((g) => ({ name: g.name, option: g.options[0].name })) })
const starsOf = async (openid) => {
  const m = await getDoc('members', openid)
  return m ? m.stars || 0 : 0
}
const logsOf = async (openid) => (await db.collection('star_logs').where({ _openid: openid }).orderBy('createdAt', 'asc').limit(100).get()).data
const order = (id) => getDoc('coffee_orders', id)
const finish = async (id) => {
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'done' }))
}
const settings = (patch) => Object.assign({ enabled: true, need: 3, earnAll: false, earnCategories: [coffeeCat], redeemAll: false, redeemCategories: [coffeeCat], maxFee: 0, validDays: 0 }, patch)

test('批次：先用最早的，同一天的并在一起，按有效期分出过期的', () => {
  assert.deepEqual(stars.addLots([{ day: '2026-10-01', n: 2 }], [{ day: '2026-09-01', n: 1 }, { day: '2026-10-01', n: 1 }]), [{ day: '2026-09-01', n: 1 }, { day: '2026-10-01', n: 3 }])
  assert.deepEqual(stars.takeLots([{ day: '2026-09-01', n: 1 }, { day: '2026-10-01', n: 3 }], 2), { left: [{ day: '2026-10-01', n: 2 }], taken: [{ day: '2026-09-01', n: 1 }, { day: '2026-10-01', n: 1 }] })
  assert.equal(stars.lotLastDay('2026-10-01', 30), '2026-10-30', '得到当天算第 1 天')
  assert.equal(stars.lotLastDay('2026-10-01', 0), '')
  const lots = [{ day: '2026-09-01', n: 1 }, { day: '2026-10-01', n: 3 }]
  assert.deepEqual(stars.splitLots(lots, 30, '2026-10-28'), { live: [{ day: '2026-10-01', n: 3 }], expired: 1 })
  assert.deepEqual(stars.splitLots(lots, 0, '2030-01-01'), { live: lots, expired: 0 }, '没设有效期一直有效')
})

test('准备：店主、咖啡师、菜单', async () => {
  db.reset()
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.coffee('seedDemo'))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: invite.code, name: '小林' }))
  menu = await ok(alice.coffee('getMenu'))
  coffeeCat = menu.categories.find((c) => c.name === '咖啡')._id
  dessertCat = menu.categories.find((c) => c.name === '甜点')._id
})

test('没开集星：结算页不显示，出餐也不给星', async () => {
  const q = await ok(alice.coffee('quote', { items: [item('拿铁')] }))
  assert.equal(q.stars, null)
  assert.equal(q.starFee, 0)
  const home = await ok(alice.common('getHome'))
  assert.equal(home.stars, null)
  const { id } = await ok(alice.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway' }))
  assert.equal((await order(id)).starsEarn, 0)
  await ok(barista.coffee('markPaid', { id }))
  await finish(id)
  assert.equal(await starsOf('ALICE'), 0)
  await fails(alice.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway', useStars: true }), 'STARS_CHANGED')
})

test('集星设置：只有店主能看能改；默认 10 颗换一杯、全部商品都算、一直有效；数值检查', async () => {
  await fails(barista.coffee('getStarSettings'), 'FORBIDDEN')
  await fails(alice.coffee('saveStarSettings', { settings: settings() }), 'FORBIDDEN')
  const s = await ok(owner.coffee('getStarSettings'))
  assert.deepEqual(s.settings, { enabled: false, need: 10, earnAll: true, earnCategories: [], redeemAll: true, redeemCategories: [], maxFee: 0, validDays: 0 })
  assert.deepEqual(s.categories.map((c) => c.name), ['咖啡', '非咖啡', '甜点'])
  await fails(owner.coffee('saveStarSettings', { settings: settings({ need: 0 }) }))
  await fails(owner.coffee('saveStarSettings', { settings: settings({ need: 101 }) }))
  await fails(owner.coffee('saveStarSettings', { settings: settings({ need: 2.5 }) }))
  await fails(owner.coffee('saveStarSettings', { settings: settings({ validDays: -1 }) }))
  await fails(owner.coffee('saveStarSettings', { settings: settings({ maxFee: -100 }) }))
  await fails(owner.coffee('saveStarSettings', { settings: settings({ earnCategories: [] }) }))
  await fails(owner.coffee('saveStarSettings', { settings: settings({ redeemCategories: ['nope'] }) }), undefined)
  const saved = await ok(owner.coffee('saveStarSettings', { settings: settings({ earnCategories: [coffeeCat, 'deleted-cat'] }) }))
  assert.deepEqual(saved.earnCategories, [coffeeCat], '删掉的分类不留')
  assert.equal(saved.need, 3)
  const home = await ok(alice.common('getHome'))
  assert.deepEqual(home.stars, { stars: 0, need: 3 })
})

test('出餐、收了款才给星：只算咖啡分类，一杯一颗；先出餐后收款的，收款时给', async () => {
  const q = await ok(alice.coffee('quote', { items: [item('拿铁', 2), item('芝士蛋糕')] }))
  assert.deepEqual(q.stars, { balance: 0, need: 3, redeem: null, used: false, earn: 2 }, '蛋糕不算')
  const { id } = await ok(alice.coffee('createOrder', { items: [item('拿铁', 2), item('芝士蛋糕')], mode: 'takeaway' }))
  assert.equal((await order(id)).starsEarn, 2)
  const pending = await ok(alice.coffee('myStars'))
  assert.equal(pending.pending, 2, '还没出餐的单显示等出餐后到账')
  await finish(id)
  assert.equal(await starsOf('ALICE'), 0, '还没收款不给')
  await ok(barista.coffee('markPaid', { id }))
  assert.equal(await starsOf('ALICE'), 2)
  const o = await order(id)
  assert.equal(o.starsCredited, true)
  const m = await getDoc('members', 'ALICE')
  assert.ok(wallet.MEMBER_NO_RE.test(m.memberNo), '没开过会员中心的顾客也自动有了会员号')
  assert.deepEqual(m.starLots, [{ day: cnDay(), n: 2 }])
  assert.equal(m.starsFrom, cnDay())

  // 先收款再出餐
  const second = await ok(alice.coffee('createOrder', { items: [item('美式')], mode: 'takeaway' }))
  await ok(barista.coffee('markPaid', { id: second.id }))
  assert.equal(await starsOf('ALICE'), 2)
  await finish(second.id)
  assert.equal(await starsOf('ALICE'), 3)
  const logs = await logsOf('ALICE')
  assert.deepEqual(logs.map((l) => [l.type, l.amount, l.stars]), [['earn', 2, 2], ['earn', 1, 3]])
  assert.equal(logs[0].refId, id)
})

test('取消的单不给星（出餐前才能取消退款，所以退款的单从来没给过星）', async () => {
  const { id } = await ok(bob.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway' }))
  await ok(barista.coffee('markPaid', { id }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'cancelled' }))
  assert.equal(await starsOf('BOB'), 0)
  await fails(barista.coffee('setOrderStatus', { id, status: 'done' }))
  assert.equal(await starsOf('BOB'), 0)
})

test('用星换一杯：挑能换的里面最贵的那杯，换的那杯不得星；扣星，取消退回原来的批次', async () => {
  const items = [item('拿铁'), item('美式'), item('芝士蛋糕')]
  const q = await ok(alice.coffee('quote', { items }))
  assert.deepEqual(q.stars.redeem, { stars: 3, productId: product('拿铁')._id, name: '拿铁', discount: 2200 }, '蛋糕不能换')
  assert.equal(q.stars.used, false, '不勾就不换')
  assert.equal(q.stars.earn, 2)
  const used = await ok(alice.coffee('quote', { items, useStars: true }))
  assert.equal(used.stars.used, true)
  assert.equal(used.stars.earn, 1, '换的拿铁不得星，美式得一颗')
  assert.equal(used.starFee, 2200)
  assert.equal(used.discountFee, 2200)
  assert.equal(used.payFee, 1800 + 2800)

  const { id } = await ok(alice.coffee('createOrder', { items, mode: 'takeaway', useStars: true }))
  const o = await order(id)
  assert.equal(o.starFee, 2200)
  assert.equal(o.payFee, 4600)
  assert.equal(o.starsEarn, 1)
  assert.equal(o.starRedeem.name, '拿铁')
  assert.deepEqual(o.starRedeem.lots, [{ day: cnDay(), n: 3 }])
  assert.equal(await starsOf('ALICE'), 0)
  const after = await ok(alice.coffee('quote', { items }))
  assert.equal(after.stars.redeem, null, '星星不够了')
  await fails(alice.coffee('createOrder', { items, mode: 'takeaway', useStars: true }), 'STARS_CHANGED')

  await ok(alice.coffee('cancelOrder', { id }))
  assert.equal(await starsOf('ALICE'), 3)
  assert.deepEqual((await getDoc('members', 'ALICE')).starLots, [{ day: cnDay(), n: 3 }])
  assert.equal((await order(id)).starsReturned, true)
  const logs = await logsOf('ALICE')
  assert.deepEqual(logs.slice(-2).map((l) => [l.type, l.amount, l.stars]), [['redeem', -3, 0], ['refund', 3, 3]])
  const m = await getDoc('members', 'ALICE')
  assert.equal(m.starsUsed, 0, '退回以后不算用过')
})

test('店员取消用星换的单（已收款）：钱和星都退回；同时用星下两单只有一单成功', async () => {
  const { id } = await ok(alice.coffee('createOrder', { items: [item('美式', 2)], mode: 'takeaway', useStars: true }))
  assert.equal((await order(id)).payFee, 1800)
  await ok(barista.coffee('markPaid', { id }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'cancelled' }))
  assert.equal(await starsOf('ALICE'), 3)

  const results = await Promise.all([
    alice.coffee('createOrder', { items: [item('美式')], mode: 'takeaway', useStars: true }),
    alice.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway', useStars: true })
  ])
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true])
  assert.equal(results.find((r) => !r.ok).code, 'STARS_CHANGED')
  assert.equal(await starsOf('ALICE'), 0)
  const done = results.find((r) => r.ok).data.id
  assert.equal((await order(done)).payMethod, 'voucher', '整单抵完不用付钱')
  assert.equal((await order(done)).payStatus, 'paid')
  await finish(done)
  assert.equal(await starsOf('ALICE'), 0, '免费换的那杯不得星')
  assert.equal((await order(done)).starsEarn, 0)
})

test('每杯最多抵多少；赠饮券先抵，星星换剩下的；代金券门槛按抵完的算', async () => {
  await ok(owner.coffee('saveStarSettings', { settings: settings({ maxFee: 2000 }) }))
  await ok(owner.member('adjustStars', { memberNo: (await getDoc('members', 'ALICE')).memberNo, amount: 3, reason: '测试' }))
  const q = await ok(alice.coffee('quote', { items: [item('拿铁')], useStars: true }))
  assert.equal(q.starFee, 2000, '拿铁 22 元最多抵 20')
  assert.equal(q.payFee, 200)

  await db.collection('vouchers').add({ data: { _id: 'drink-star', _openid: 'ALICE', title: '包天赠饮', productIds: [], maxFee: 0, day: cnDay(), status: 'unused', createdAt: new Date() } })
  const both = await ok(alice.coffee('quote', { items: [item('拿铁', 2)], useStars: true }))
  assert.equal(both.voucherFee, 2200)
  assert.equal(both.starFee, 2000)
  assert.equal(both.stars.earn, 0, '两杯都是免费的')
  assert.equal(both.payFee, 200)
  const one = await ok(alice.coffee('quote', { items: [item('拿铁')], useStars: true }))
  assert.equal(one.stars.redeem, null, '唯一一杯被赠饮券抵了，没有能换的')
  assert.equal(one.stars.used, false)
  await fails(alice.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway', voucherIds: ['drink-star'], useStars: true }), 'STARS_CHANGED')
  assert.equal((await getDoc('vouchers', 'drink-star')).status, 'unused')
  await db.collection('vouchers').doc('drink-star').remove()

  // 满 20 减 5：不用星时拿铁 22 元够门槛，用星抵到 2 元就不够了
  const coupon = await ok(owner.coffee('saveCoupon', { coupon: { amount: 500, minSpend: 2000, validDays: 7 } }))
  await ok(alice.coffee('claimCoupon', { id: coupon.id }))
  assert.equal((await ok(alice.coffee('quote', { items: [item('拿铁')] }))).couponFee, 500)
  const withStars = await ok(alice.coffee('quote', { items: [item('拿铁')], useStars: true }))
  assert.equal(withStars.couponFee, 0)
  assert.equal(withStars.coupons[0].discount, 0)
  const cash = (await ok(alice.coffee('myVouchers'))).usable.find((v) => v.type === 'cash')
  await fails(alice.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway', couponId: cash._id, useStars: true }), 'VOUCHER_CHANGED')
  assert.equal(await starsOf('ALICE'), 3, '没下成单，星星没扣')
  await ok(owner.coffee('saveStarSettings', { settings: settings() }))
})

test('有效期：每颗星从得到那天起算，过期的不能用，定时清掉并记一笔', async () => {
  const today = cnDay()
  const old = wallet.addDays(today, -40)
  const mid = wallet.addDays(today, -20)
  await setDoc('members', 'ALICE', { stars: 6, starLots: db.command.set([{ day: old, n: 2 }, { day: mid, n: 1 }, { day: today, n: 3 }]), starsFrom: old })
  await ok(owner.coffee('saveStarSettings', { settings: settings({ validDays: 30 }) }))
  const mine = await ok(alice.coffee('myStars'))
  assert.equal(mine.stars, 4, '40 天前的 2 颗过期了')
  assert.deepEqual(mine.expiring, { n: 1, day: wallet.addDays(mid, 29) })
  assert.equal(mine.validDays, 30)
  const detail = await ok(owner.member('getMemberDetail', { memberNo: (await getDoc('members', 'ALICE')).memberNo }))
  assert.equal(detail.member.stars, 4)

  assert.equal(await stars.expireAll(db), 1)
  const m = await getDoc('members', 'ALICE')
  assert.equal(m.stars, 4)
  assert.deepEqual(m.starLots, [{ day: mid, n: 1 }, { day: today, n: 3 }])
  assert.equal(m.starsFrom, mid)
  const last = (await logsOf('ALICE')).pop()
  assert.deepEqual([last.type, last.amount, last.stars], ['expire', -2, 4])
  assert.equal(await stars.expireAll(db), 0, '清过一次不会再清')

  // 兑换先用最早的
  const { id } = await ok(alice.coffee('createOrder', { items: [item('美式'), item('拿铁')], mode: 'takeaway', useStars: true }))
  assert.deepEqual((await order(id)).starRedeem.lots, [{ day: mid, n: 1 }, { day: today, n: 2 }])
  assert.deepEqual((await getDoc('members', 'ALICE')).starLots, [{ day: today, n: 1 }])
  await ok(alice.coffee('cancelOrder', { id }))
  assert.deepEqual((await getDoc('members', 'ALICE')).starLots, [{ day: mid, n: 1 }, { day: today, n: 3 }], '退回原来的批次')
  await ok(owner.coffee('saveStarSettings', { settings: settings() }))
})

test('店主加减星：要写原因，扣不能扣成负数；咖啡师不能改；会员详情能看到星星流水', async () => {
  const no = (await getDoc('members', 'ALICE')).memberNo
  await fails(barista.member('adjustStars', { memberNo: no, amount: 2, reason: '补' }), 'FORBIDDEN')
  await fails(owner.member('adjustStars', { memberNo: no, amount: 2 }))
  await fails(owner.member('adjustStars', { memberNo: no, amount: 0, reason: '补' }))
  await fails(owner.member('adjustStars', { memberNo: no, amount: 1.5, reason: '补' }))
  await fails(owner.member('adjustStars', { memberNo: no, amount: -100, reason: '扣' }), 'STARS_LOW')
  const res = await ok(owner.member('adjustStars', { memberNo: no, amount: 2, reason: '在店里买了没用小程序' }))
  assert.equal(res.stars, 6)
  await ok(owner.member('adjustStars', { memberNo: no, amount: -1, reason: '多给了' }))
  const detail = await ok(barista.member('getMemberDetail', { memberNo: no }))
  assert.equal(detail.member.stars, 5)
  assert.deepEqual(detail.starSettings, { enabled: true, need: 3 })
  assert.equal(detail.starLogs[0].typeName, '店主调整')
  assert.equal(detail.starLogs[0].amount, -1)
  assert.equal(detail.starLogs[0].operatorName, '坤总')
  assert.equal(detail.starLogs[0].reason, '多给了')
  const list = await ok(barista.member('listMembers', { keyword: no }))
  assert.equal(list.members[0].stars, 5)
})

test('我的星星：规则、颗数、变动记录；关掉集星后顾客看到没开', async () => {
  const mine = await ok(alice.coffee('myStars'))
  assert.equal(mine.enabled, true)
  assert.equal(mine.need, 3)
  assert.equal(mine.earnAll, false)
  assert.deepEqual(mine.earnNames, ['咖啡'])
  assert.deepEqual(mine.redeemNames, ['咖啡'])
  assert.equal(mine.stars, 5)
  assert.equal(mine.expiring, null, '一直有效')
  assert.equal(mine.logs[0].typeName, '店主调整')
  assert.equal(mine.logs[0].operatorName, undefined, '顾客看不到操作人')
  const empty = await ok(bob.coffee('myStars'))
  assert.equal(empty.stars, 0)
  assert.equal(empty.memberNo, '')

  const s = await ok(owner.coffee('getStarSettings'))
  assert.equal(s.stats.holders, 1)
  assert.equal(s.stats.stars, 5)
  assert.ok(s.stats.earned >= 3)

  await ok(owner.coffee('saveStarSettings', { settings: settings({ enabled: false }) }))
  assert.equal((await ok(alice.coffee('myStars'))).enabled, false)
  assert.equal((await ok(alice.coffee('quote', { items: [item('拿铁')] }))).stars, null)
  await ok(owner.coffee('saveStarSettings', { settings: settings({ earnAll: true, redeemAll: true }) }))
  const all = await ok(alice.coffee('quote', { items: [item('芝士蛋糕')] }))
  assert.equal(all.stars.earn, 1, '全部商品都算时蛋糕也得星')
  assert.equal(all.stars.redeem.name, '芝士蛋糕')
})

test('出餐以后顾客才用余额付的，付了就给星', async () => {
  const bobNo = (await wallet.ensureMember(db, 'BOB')).memberNo
  await ok(owner.member('adjustMember', { memberNo: bobNo, amount: 5000, reason: '测试' }))
  const { id } = await ok(bob.coffee('createOrder', { items: [item('美式')], mode: 'takeaway' }))
  await finish(id)
  assert.equal(await starsOf('BOB'), 0)
  await ok(bob.coffee('payWithBalance', { id }))
  assert.equal(await starsOf('BOB'), 1)
})

test('每日汇总：集星换了几杯、抵了多少、发了多少颗星', async () => {
  const sum = await ok(owner.coffee('daySummary', {}))
  const t = sum.totals
  assert.equal(t.starCups, 1, '取消的单不算')
  assert.equal(t.starFee, 1800)
  assert.equal(t.starsIssued, 4)
  assert.equal(t.discountFee, 1800)
})
