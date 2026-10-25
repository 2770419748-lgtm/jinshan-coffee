// 用内存数据库把第 1 步的主要流程完整跑一遍：店主绑定 → 导入菜单 → 顾客下单 → 店员接单出餐
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap } = require('./helpers/load')

const owner = as('OWNER')
const alice = as('ALICE') // 顾客
const bob = as('BOB') // 另一位顾客
const barista = as('BARISTA')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

let menu
let orderId

test('第一次打开：空数据库，还没有店主', async () => {
  db.reset()
  const me = await ok(alice.common('login'))
  assert.equal(me.staff, null)
  assert.equal(me.hasOwner, false)
  const empty = await ok(alice.coffee('getMenu'))
  assert.deepEqual(empty, { categories: [], products: [] })
})

test('店主绑定只能一次；顾客进不了后台', async () => {
  await fails(alice.coffee('seedDemo'), 'FORBIDDEN')
  const staff = await ok(owner.common('bindOwner', { name: '坤总' }))
  assert.equal(staff.role, 'owner')
  await fails(alice.common('bindOwner', { name: '路人' }))
  const me = await ok(owner.common('login'))
  assert.equal(me.staff.roleName, '店主')
  assert.equal(me.hasOwner, true)
  await fails(alice.coffee('listOrders'), 'FORBIDDEN')
})

test('导入示例菜单，顾客端能看到', async () => {
  const seeded = await ok(owner.coffee('seedDemo'))
  assert.equal(seeded.productCount, 6)
  await fails(owner.coffee('seedDemo'))
  menu = await ok(alice.coffee('getMenu'))
  assert.deepEqual(menu.categories.map((c) => c.name), ['咖啡', '非咖啡', '甜点'])
  assert.equal(menu.products.length, 6)
})

test('桌号按自然顺序排列，重复桌号不能加', async () => {
  for (const no of ['10', '2', '5', 'a3']) await ok(owner.coffee('saveTable', { tableNo: no }))
  await fails(owner.coffee('saveTable', { tableNo: '5' }))
  await fails(owner.coffee('saveTable', { tableNo: '5号桌' }))
  const tables = await ok(owner.coffee('listTables'))
  assert.deepEqual(tables.map((t) => t.tableNo), ['2', '5', '10', 'A3'])
  const t5 = tables.find((t) => t.tableNo === '5')
  const code = await ok(owner.coffee('genTableCode', { id: t5._id, envVersion: 'trial' }))
  assert.equal(code.envVersion, 'trial')
  assert.equal(state.lastCodeParams.scene, 't=5')
  assert.equal(state.lastCodeParams.page, 'pages/menu/menu')
  assert.equal(state.lastCodeParams.checkPath, false)
})

const byName = (name) => menu.products.find((p) => p.name === name)

test('顾客扫 5 号桌下单：服务器算价，取餐号从 001 开始', async () => {
  const latte = byName('拿铁')
  const pour = byName('手冲')
  const res = await ok(alice.coffee('createOrder', {
    mode: 'dine_in',
    tableNo: '5',
    remark: '少冰',
    items: [
      { productId: latte._id, qty: 2, unitPrice: 1, specs: [{ name: '杯型', option: '大杯' }, { name: '温度', option: '冰' }] },
      { productId: pour._id, qty: 1, specs: [] }
    ]
  }))
  orderId = res.id
  const order = await ok(alice.coffee('getOrder', { id: orderId }))
  assert.equal(order.payFee, (2200 + 300) * 2 + 3200)
  assert.equal(order.pickupNo, '001')
  assert.equal(order.tableNo, '5')
  assert.equal(order.status, 'pending')
  assert.equal(order.payStatus, 'unpaid')
  assert.equal(order._openid, undefined, '不应把 openid 返回给前端')

  const second = await ok(bob.coffee('createOrder', { mode: 'takeaway', tableNo: '5', items: [{ productId: pour._id, qty: 1 }] }))
  const order2 = await ok(bob.coffee('getOrder', { id: second.id }))
  assert.equal(order2.pickupNo, '002')
  assert.equal(order2.tableNo, '', '外带不记桌号')
})

test('下单校验：规格不对、桌码失效、售罄、模式不对', async () => {
  const latte = byName('拿铁')
  await fails(alice.coffee('createOrder', { mode: 'dine_in', items: [{ productId: latte._id, qty: 1, specs: [] }] }), 'MENU_CHANGED')
  await fails(alice.coffee('createOrder', { mode: 'dine_in', tableNo: '99', items: [{ productId: byName('手冲')._id, qty: 1 }] }), 'TABLE_INVALID')
  await fails(alice.coffee('createOrder', { mode: 'delivery', items: [{ productId: byName('手冲')._id, qty: 1 }] }))
  await ok(owner.coffee('setProductFlags', { id: byName('柠檬茶')._id, soldOut: true }))
  await fails(alice.coffee('createOrder', {
    mode: 'takeaway',
    items: [{ productId: byName('柠檬茶')._id, qty: 1, specs: [{ name: '糖度', option: '少糖' }] }]
  }), 'MENU_CHANGED')
  const fresh = await ok(alice.coffee('getMenu'))
  assert.equal(fresh.products.find((p) => p.name === '柠檬茶').soldOut, true, '售罄商品仍显示但标记售罄')
})

test('别的顾客看不到我的订单', async () => {
  await fails(bob.coffee('getOrder', { id: orderId }), 'FORBIDDEN')
  const mine = await ok(alice.coffee('myOrders', { page: 0 }))
  assert.equal(mine.orders.length, 1)
})

test('员工邀请：咖啡师能接单，但管不了员工；邀请码只能用一次', async () => {
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  assert.match(invite.code, /^\d{6}$/)
  await fails(barista.common('bindStaff', { name: '小王', code: '000000' }))
  const staff = await ok(barista.common('bindStaff', { name: '小王', code: invite.code }))
  assert.equal(staff.role, 'barista')
  await fails(bob.common('bindStaff', { name: '冒充', code: invite.code }))
  await fails(barista.common('listStaff'), 'FORBIDDEN')
  await fails(barista.coffee('seedDemo'), 'FORBIDDEN')
  const list = await ok(owner.common('listStaff'))
  assert.deepEqual(list.map((s) => s.roleName).sort(), ['咖啡师', '店主'].sort())
  await fails(owner.common('updateStaff', { id: 'OWNER', role: 'barista' }))
  await fails(owner.common('removeStaff', { id: 'OWNER' }))
})

test('咖啡师接单：收款、制作、完成，状态只能往前走', async () => {
  const pending = await ok(barista.coffee('listOrders', { status: 'pending' }))
  assert.equal(pending.counts.pending, 2)
  assert.ok(pending.pendingIds.indexOf(orderId) !== -1)
  assert.equal(pending.orders[0].pickupNo, '001', '待制作按下单先后排')

  await ok(barista.coffee('markPaid', { id: orderId }))
  await fails(barista.coffee('markPaid', { id: orderId }))
  await fails(barista.coffee('setOrderStatus', { id: orderId, status: 'done' }))
  await ok(barista.coffee('setOrderStatus', { id: orderId, status: 'making' }))
  await fails(alice.coffee('cancelOrder', { id: orderId }))
  await ok(barista.coffee('setOrderStatus', { id: orderId, status: 'done' }))
  await fails(barista.coffee('setOrderStatus', { id: orderId, status: 'making' }))

  const order = await ok(alice.coffee('getOrder', { id: orderId }))
  assert.equal(order.status, 'done')
  assert.equal(order.payStatus, 'paid')
  const done = await ok(barista.coffee('listOrders', { status: 'done' }))
  assert.equal(done.counts.done, 1)
  assert.equal(done.counts.pending, 1)
})

test('顾客可以取消还没付款、没开始做的订单', async () => {
  const pour = byName('手冲')
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour._id, qty: 1 }] }))
  await fails(bob.coffee('cancelOrder', { id }))
  await ok(alice.coffee('cancelOrder', { id }))
  const order = await ok(alice.coffee('getOrder', { id }))
  assert.equal(order.status, 'cancelled')
  await fails(barista.coffee('markPaid', { id }))
})

test('商品编辑：改价、换规格、校验；分类有商品不能删', async () => {
  const latte = await ok(owner.coffee('getProduct', { id: byName('拿铁')._id }))
  await ok(owner.coffee('saveProduct', {
    product: Object.assign({}, latte, { price: 2500, specs: [{ name: '温度', options: [{ name: '热', price: 0 }] }] })
  }))
  const updated = await ok(owner.coffee('getProduct', { id: latte._id }))
  assert.equal(updated.price, 2500)
  assert.deepEqual(updated.specs, [{ name: '温度', options: [{ name: '热', price: 0 }] }])

  await fails(owner.coffee('saveProduct', { product: Object.assign({}, latte, { price: 25.5 }) }))
  await fails(owner.coffee('saveProduct', { product: Object.assign({}, latte, { categoryId: 'nope' }) }))
  await fails(owner.coffee('saveProduct', { product: { name: '', price: 100, categoryId: latte.categoryId } }))
  const created = await ok(barista.coffee('saveProduct', { product: { name: '新品', price: 1990, categoryId: latte.categoryId } }))
  assert.ok(created.id)

  await fails(owner.coffee('deleteCategory', { id: latte.categoryId }))
  const cat = await ok(owner.coffee('saveCategory', { name: '季节限定' }))
  await fails(owner.coffee('saveCategory', { name: '季节限定' }))
  const { categories } = await ok(owner.coffee('adminListProducts'))
  const ids = categories.map((c) => c._id).reverse()
  await ok(owner.coffee('sortCategories', { ids }))
  const after = await ok(owner.coffee('adminListProducts'))
  assert.equal(after.categories[0]._id, cat.id)
  await ok(owner.coffee('deleteCategory', { id: cat.id }))
})

test('删除商品会顺带清掉图片', async () => {
  const p = menu.products.find((x) => x.name === '芝士蛋糕')
  const full = await ok(owner.coffee('getProduct', { id: p._id }))
  await ok(owner.coffee('saveProduct', { product: Object.assign({}, full, { image: '/uploads/products/202610/cake.jpg' }) }))
  await ok(owner.coffee('deleteProduct', { id: p._id }))
  assert.ok(state.deleted.indexOf('/uploads/products/202610/cake.jpg') !== -1)
})
