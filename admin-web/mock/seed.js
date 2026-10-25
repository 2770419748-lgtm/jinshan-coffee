// 预览用的假数据：店主、员工、示例菜单和书、轮播、代金券、会员储值、几张订单和借书单
module.exports = async function seed(as, db) {
  const ok = async (p) => {
    const res = await p
    if (!res.ok) throw new Error(res.msg)
    return res.data
  }
  const owner = as('OWNER')
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.common('setWebAccount', { username: 'boss', password: 'jinshan2026' }))
  for (const [id, role, name] of [['BARISTA', 'barista', '小王'], ['KEEPER', 'book_manager', '小李']]) {
    const invite = await ok(owner.common('createInvite', { role }))
    await ok(as(id).common('bindStaff', { name, code: invite.code }))
  }
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
  for (const no of ['1', '2', '3', '5', 'A1']) await ok(owner.coffee('saveTable', { tableNo: no }))
  const menu = await ok(owner.coffee('getMenu'))
  const byName = (n) => menu.products.find((p) => p.name === n)
  const cup = [{ name: '杯型', option: '大杯' }, { name: '温度', option: '冰' }]
  const customers = ['C1', 'C2', 'C3', 'C4'].map(as)
  await ok(owner.common('saveBanner', { banner: { kind: 'product', targetId: byName('拿铁')._id, title: '秋季新品 桂花拿铁' } }))
  await ok(owner.common('saveBanner', { banner: { kind: 'coupons', subtitle: '满 30 减 5，先到先得' } }))
  const c30 = await ok(owner.coffee('saveCoupon', { coupon: { amount: 500, minSpend: 3000, validDays: 7, total: 100, perUser: 1 } }))
  await ok(owner.coffee('saveCoupon', { coupon: { title: '新人券', amount: 300, validDays: 3, perUser: 1 } }))
  await ok(customers[1].coffee('claimCoupon', { id: c30.id }))
  await ok(customers[2].coffee('claimCoupon', { id: c30.id }))
  const o1 = await ok(customers[0].coffee('createOrder', { mode: 'dine_in', tableNo: '5', remark: '少冰', items: [{ productId: byName('拿铁')._id, qty: 2, specs: cup }, { productId: byName('芝士蛋糕')._id, qty: 1 }] }))
  const q2 = await ok(customers[1].coffee('quote', { items: [{ productId: byName('手冲')._id, qty: 1 }] }))
  const o2 = await ok(customers[1].coffee('createOrder', { mode: 'takeaway', items: [{ productId: byName('手冲')._id, qty: 1 }], couponId: q2.coupon.id }))
  // 预览里没有微信支付下不了预约单，直接把这单改成两小时后取的预约单
  await db.collection('coffee_orders').doc(o2.id).update({ data: { reserveAt: new Date(Date.now() + 2 * 3600000) } })
  const o3 = await ok(customers[2].coffee('createOrder', { mode: 'dine_in', tableNo: 'A1', items: [{ productId: byName('美式')._id, qty: 1, specs: [{ name: '杯型', option: '中杯' }, { name: '温度', option: '热' }] }] }))
  await ok(owner.coffee('markPaid', { id: o1.id }))
  await ok(owner.coffee('markPaid', { id: o3.id }))
  await ok(owner.coffee('setOrderStatus', { id: o3.id, status: 'making' }))
  const shelf = await ok(owner.book('getShelf'))
  const hourly = shelf.rules.find((r) => r.type === 'hourly')
  const day = shelf.rules.find((r) => r.type === 'day')
  const r1 = await ok(customers[0].book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 2 }))
  await ok(owner.book('markRentalPaid', { id: r1.id }))
  await ok(owner.book('handOut', { id: r1.id }))
  // 让这本书已经超时 25 分钟
  await db.collection('book_rentals').doc(r1.id).update({ data: { dueAt: new Date(Date.now() - 25 * 60000) } })
  const r2 = await ok(customers[3].book('createRental', { bookId: shelf.books[2]._id, ruleId: day._id }))
  await ok(owner.book('markRentalPaid', { id: r2.id }))
  await ok(customers[1].book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 1, remark: '靠窗位' }))

  // 会员储值：两个档位，C1 在吧台充了 300 送 100，用余额点了一单；C4 是没充过钱的
  const p300 = await ok(owner.member('savePlan', { plan: { price: 30000, bonus: 10000, memberDays: 365, desc: '送一年会员' } }))
  await ok(owner.member('savePlan', { plan: { price: 50000, bonus: 20000, memberDays: 365, desc: '最划算' } }))
  await ok(owner.member('saveMemberSettings', { enabled: true, freeCategories: ['漫画'], notice: '储值金额（含赠送）只能在店里点单、借书时使用，不能提现。' }))
  await ok(owner.book('saveBook', { book: { title: '海贼王 1', author: '尾田荣一郎', category: '漫画', copies: 2 } }))
  const m1 = await ok(customers[0].member('getMember'))
  await ok(customers[3].member('getMember'))
  await ok(as('BARISTA').member('counterRecharge', { memberNo: m1.member.memberNo, planId: p300.id }))
  await ok(as('BARISTA').member('setMemberRemark', { memberNo: m1.member.memberNo, remark: '张女士 尾号 6688' }))
  await ok(customers[0].coffee('createOrder', { mode: 'takeaway', payBy: 'balance', items: [{ productId: byName('美式')._id, qty: 1, specs: [{ name: '杯型', option: '中杯' }, { name: '温度', option: '冰' }] }] }))
}
