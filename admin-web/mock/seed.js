// 预览用的假数据：店主、员工、示例菜单和书、几张订单和借书单
module.exports = async function seed(cloud, as) {
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
  const o1 = await ok(customers[0].coffee('createOrder', { mode: 'dine_in', tableNo: '5', remark: '少冰', items: [{ productId: byName('拿铁')._id, qty: 2, specs: cup }, { productId: byName('芝士蛋糕')._id, qty: 1 }] }))
  await ok(customers[1].coffee('createOrder', { mode: 'takeaway', items: [{ productId: byName('手冲')._id, qty: 1 }] }))
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
  cloud.__db.collections.book_rentals[r1.id].dueAt = new Date(Date.now() - 25 * 60000)
  const r2 = await ok(customers[3].book('createRental', { bookId: shelf.books[2]._id, ruleId: day._id }))
  await ok(owner.book('markRentalPaid', { id: r2.id }))
  await ok(customers[1].book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 1, remark: '靠窗位' }))
}
