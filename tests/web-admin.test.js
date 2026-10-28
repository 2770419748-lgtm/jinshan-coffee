// 第 3 步：电脑网页后台的账号登录、每日汇总、Excel 导入书目
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, as, unwrap, getDoc, setDoc } = require('./helpers/load')

const owner = as('OWNER')
const barista = as('BARISTA')
const alice = as('ALICE')
const anon = as('') // 网页里没有微信身份

// 网页后台调用：没有 openid，带 webToken
function web(token) {
  const wrap = (fn) => (action, data) => fn(action, Object.assign({ webToken: token }, data || {}))
  return { common: wrap(anon.common), coffee: wrap(anon.coffee), book: wrap(anon.book) }
}

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

let ownerToken

test('准备：店主和咖啡师', async () => {
  db.reset()
  await ok(owner.common('bindOwner', { name: '坤总' }))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { name: '小王', code: invite.code }))
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
})

test('员工在小程序里设网页账号；顾客设不了', async () => {
  await fails(alice.common('setWebAccount', { username: 'alice', password: 'abc12345' }), 'FORBIDDEN')
  await fails(owner.common('setWebAccount', { username: 'A', password: 'abc12345' }))
  await fails(owner.common('setWebAccount', { username: 'boss', password: 'short1' }))
  await fails(owner.common('setWebAccount', { username: 'boss', password: 'onlyletters' }))
  assert.deepEqual(await ok(owner.common('setWebAccount', { username: 'Boss', password: 'jinshan2026' })), { username: 'boss' })
  await fails(barista.common('setWebAccount', { username: 'boss', password: 'coffee2026' }))
  await ok(barista.common('setWebAccount', { username: 'wang', password: 'coffee2026' }))
  assert.equal((await ok(owner.common('getWebAccount'))).username, 'boss')
  const staff = await getDoc('staff', 'OWNER')
  assert.notEqual(staff.web.hash, 'jinshan2026', '密码不能明文存')
  const list = await ok(owner.common('listStaff'))
  assert.deepEqual(list.map((s) => s.webUsername).sort(), ['boss', 'wang'])
  assert.ok(!JSON.stringify(list).includes(staff.web.hash), '员工列表不返回密码')
})

test('没登录的网页调用只能登录', async () => {
  await fails(anon.coffee('listOrders'), 'NEED_LOGIN')
  await fails(anon.coffee('createOrder', { mode: 'takeaway', items: [] }), 'NEED_LOGIN')
  await fails(anon.book('getShelf'), 'NEED_LOGIN')
  await fails(web('x'.repeat(64)).coffee('listOrders'), 'NEED_LOGIN')
  const me = await ok(anon.common('login'))
  assert.equal(me.staff, null)
})

test('网页登录：密码错 5 次锁 15 分钟；登录后用员工身份操作', async () => {
  await fails(anon.common('webLogin', { username: 'boss', password: 'wrong' }))
  await fails(anon.common('webLogin', { username: 'nobody', password: 'jinshan2026' }))
  const res = await ok(anon.common('webLogin', { username: 'BOSS', password: 'jinshan2026' }))
  ownerToken = res.token
  assert.match(ownerToken, /^[0-9a-f]{64}$/)
  assert.equal(res.staff.role, 'owner')
  assert.equal(await getDoc('web_sessions', ownerToken), null, '数据库里只存 token 的哈希')

  const boss = web(ownerToken)
  assert.equal((await ok(boss.common('login'))).staff.roleName, '店主')
  const orders = await ok(boss.coffee('listOrders', { status: 'pending' }))
  assert.equal(orders.counts.pending, 0)

  for (let i = 0; i < 5; i++) await fails(anon.common('webLogin', { username: 'wang', password: 'nope' + i }))
  const locked = await fails(anon.common('webLogin', { username: 'wang', password: 'coffee2026' }))
  assert.match(locked.msg, /分钟后再试/)
  await setDoc('staff', 'BARISTA', { web: { lockUntil: Date.now() - 1 } })
  const wang = await ok(anon.common('webLogin', { username: 'wang', password: 'coffee2026' }))
  await fails(web(wang.token).common('listStaff'), 'FORBIDDEN')
  await fails(web(wang.token).coffee('daySummary'), 'FORBIDDEN')
  assert.ok(await ok(web(wang.token).coffee('adminListProducts')))

  // 店主停用咖啡师的网页账号，已经登录的也立刻失效
  await ok(boss.common('clearWebAccount', { id: 'BARISTA' }))
  await fails(web(wang.token).coffee('adminListProducts'), 'NEED_LOGIN')
  await fails(anon.common('webLogin', { username: 'wang', password: 'coffee2026' }))
})

test('退出登录、改密码、登录过期都会让 token 失效', async () => {
  const a = await ok(anon.common('webLogin', { username: 'boss', password: 'jinshan2026' }))
  await ok(anon.common('webLogout', { webToken: a.token }))
  await fails(web(a.token).coffee('listOrders'), 'NEED_LOGIN')

  const b = await ok(anon.common('webLogin', { username: 'boss', password: 'jinshan2026' }))
  await db.collection('web_sessions').where({ staffId: 'OWNER' }).update({ data: { expiresAt: Date.now() - 1 } })
  await fails(web(b.token).coffee('listOrders'), 'NEED_LOGIN')

  const c = await ok(anon.common('webLogin', { username: 'boss', password: 'jinshan2026' }))
  await ok(owner.common('setWebAccount', { username: 'boss', password: 'newpass2026' }))
  await fails(web(c.token).coffee('listOrders'), 'NEED_LOGIN')
  ownerToken = (await ok(anon.common('webLogin', { username: 'boss', password: 'newpass2026' }))).token
})

test('每日汇总：单数、收款、赠饮抵扣、热销商品、借书租金和超时费', async () => {
  const boss = web(ownerToken)
  const menu = await ok(alice.coffee('getMenu'))
  const pour = menu.products.find((p) => p.name === '手冲')
  const cake = menu.products.find((p) => p.name === '芝士蛋糕')
  const o1 = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour._id, qty: 2 }] }))
  await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: cake._id, qty: 1 }] }))
  const o3 = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: pour._id, qty: 1 }] }))
  await ok(boss.coffee('markPaid', { id: o1.id }))
  await ok(alice.coffee('cancelOrder', { id: o3.id }))

  const sum = await ok(boss.coffee('daySummary', {}))
  assert.equal(sum.days.length, 1)
  const t = sum.totals
  assert.equal(t.orders, 2)
  assert.equal(t.cancelled, 1)
  assert.equal(t.paidFee, 6400)
  assert.equal(t.counterFee, 6400)
  assert.equal(t.unpaidFee, cake.price)
  assert.deepEqual(sum.products.map((p) => [p.name, p.qty]), [['手冲', 2], ['芝士蛋糕', 1]])

  const shelf = await ok(alice.book('getShelf'))
  const hourly = shelf.rules.find((r) => r.type === 'hourly')
  const r1 = await ok(alice.book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 2 }))
  await ok(boss.book('markRentalPaid', { id: r1.id }))
  await ok(boss.book('handOut', { id: r1.id }))
  await setDoc('book_rentals', r1.id, { dueAt: new Date(Date.now() - 30 * 60000) })
  await ok(boss.book('returnBook', { id: r1.id }))
  await ok(boss.book('markOvertimePaid', { id: r1.id }))
  const bs = await ok(boss.book('daySummary', {}))
  assert.equal(bs.totals.rentals, 1)
  assert.equal(bs.totals.paidFee, 1600)
  assert.equal(bs.totals.overtimePaid, 800)
  assert.deepEqual(bs.rules.map((r) => [r.name, r.count]), [['按小时', 1]])

  const week = await ok(boss.coffee('daySummary', { from: '2026-01-01', to: '2026-01-07' }))
  assert.equal(week.days.length, 7)
  assert.equal(week.totals.orders, 0)
  await fails(boss.coffee('daySummary', { from: '2026-01-07', to: '2026-01-01' }))
  await fails(boss.coffee('daySummary', { from: '2026-01-01', to: '2026-06-01' }))
})

test('Excel 导入书目：重复 ISBN、册数不对、没书名的跳过', async () => {
  const boss = web(ownerToken)
  const res = await ok(boss.book('importBooks', {
    books: [
      { title: '百年孤独', author: '马尔克斯', isbn: '978-7-5442-4499-0', category: '文学', copies: 2 },
      { title: '重复的', isbn: '9787544244990' },
      { title: '', author: '无名' },
      { title: '册数不对', copies: 0 },
      { title: '没 ISBN 也行', copies: '3' }
    ]
  }))
  assert.equal(res.created, 2)
  assert.deepEqual(res.skipped.map((s) => s.index), [1, 2, 3])
  const books = await ok(boss.book('adminListBooks'))
  const added = books.find((b) => b.title === '没 ISBN 也行')
  assert.equal(added.copies, 3)
  assert.equal(added.available, 3)
  await fails(barista.book('importBooks', { books: [{ title: 'x' }] }), 'FORBIDDEN')
})

test('移除员工时，他的网页登录也失效', async () => {
  const invite = await ok(owner.common('createInvite', { role: 'book_manager' }))
  const keeper = as('KEEPER')
  await ok(keeper.common('bindStaff', { name: '小李', code: invite.code }))
  await ok(keeper.common('setWebAccount', { username: 'xiaoli', password: 'books2026' }))
  const { token } = await ok(anon.common('webLogin', { username: 'xiaoli', password: 'books2026' }))
  assert.ok(await ok(web(token).book('adminListBooks')))
  await ok(owner.common('removeStaff', { id: 'KEEPER' }))
  await fails(web(token).book('adminListBooks'), 'NEED_LOGIN')
})
