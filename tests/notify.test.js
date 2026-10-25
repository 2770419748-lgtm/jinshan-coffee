// 订单提醒：收银电脑取新单打小票；订阅消息（出餐通知顾客取餐、按小时借书到期前提醒）
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc, setDoc, modules } = require('./helpers/load')
const notify = require('../server/functions/notify')

const owner = as('OWNER')
const barista = as('BARISTA')
const alice = as('ALICE')
const bob = as('BOB')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}
// 出餐通知不等微信回复，等它发完再看
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

// 公众平台模板库里常见的几种写法
const PICKUP = { priTmplId: 'TPL_PICKUP', title: '取餐提醒', type: 2, content: '取餐号:{{character_string1.DATA}}\n商品名称:{{thing2.DATA}}\n门店名称:{{thing3.DATA}}\n温馨提示:{{thing4.DATA}}\n' }
const DONE = { priTmplId: 'TPL_DONE', title: '订单完成通知', type: 2, content: '订单编号:{{character_string1.DATA}}\n订单状态:{{phrase2.DATA}}\n完成时间:{{time3.DATA}}\n备注:{{thing4.DATA}}\n' }
const DUE = { priTmplId: 'TPL_DUE', title: '到期提醒', type: 2, content: '物品名称:{{thing1.DATA}}\n借阅号:{{character_string4.DATA}}\n到期时间:{{time2.DATA}}\n温馨提示:{{thing3.DATA}}\n' }

let menu
let shelf

test('模板字段：按名称决定填什么，按类型截成微信接受的格式', () => {
  const fields = notify.parseFields(PICKUP.content)
  assert.deepEqual(fields.map((f) => [f.key, f.label, f.type]), [
    ['character_string1', '取餐号', 'character_string'],
    ['thing2', '商品名称', 'thing'],
    ['thing3', '门店名称', 'thing'],
    ['thing4', '温馨提示', 'thing']
  ])
  assert.deepEqual(notify.mapFields('orderReady', fields).map((f) => f.use), ['pickupNo', 'items', 'shop', 'tip'])
  assert.deepEqual(notify.mapFields('orderReady', notify.parseFields(DONE.content)).map((f) => f.use), ['orderNo', 'status', 'time', 'tip'])
  assert.deepEqual(notify.mapFields('rentalDue', notify.parseFields(DUE.content)).map((f) => f.use), ['book', 'code', 'due', 'tip'])
  // 名称对不上时按类型兜底
  assert.deepEqual(notify.mapFields('orderReady', notify.parseFields('甲：{{phrase1.DATA}}\n乙：{{thing2.DATA}}')).map((f) => f.use), ['status', 'tip'])

  assert.equal(notify.format({ text: '一二三四五六七八九十一二三四五六七八九十多出来' }, 'thing'), '一二三四五六七八九十一二三四五六七八九十')
  assert.equal(notify.format({ text: '已做好啦，快来取' }, 'phrase'), '已做好啦快')
  assert.equal(notify.format({ text: '5 号桌' }, 'character_string'), '5')
  assert.equal(notify.format({ text: '取餐号 012' }, 'number'), '012')
  assert.equal(notify.format({ fen: 6450 }, 'amount'), '¥64.50')
  assert.equal(notify.format({ ms: Date.parse('2026-10-26T06:03:00Z') }, 'time'), '2026年10月26日 14:03', '按北京时间')
  assert.equal(notify.format({ text: '' }, 'thing'), '-', '不能是空的')
})

test('准备：店主、咖啡师、菜单、书', async () => {
  db.reset()
  state.payReady = false
  state.templates = [PICKUP, DONE, DUE]
  state.sent = []
  state.sendError = 0
  await ok(owner.common('bindOwner', { name: '坤总' }))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: invite.code, name: '小林' }))
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
  menu = await ok(alice.coffee('getMenu'))
  shelf = await ok(alice.book('getShelf'))
})

const latte = () => menu.products.find((p) => p.name === '拿铁')
const cake = () => menu.products.find((p) => p.name === '芝士蛋糕')
const cup = () => latte().specs.map((g) => ({ name: g.name, option: g.options[0].name }))
const order = (who, extra) => who.coffee('createOrder', Object.assign({
  mode: 'dine_in',
  items: [{ productId: latte()._id, qty: 2, specs: cup() }, { productId: cake()._id, qty: 1 }]
}, extra))

test('收银电脑打小票：按 id 取新单，顾客取不到；没付款的预约单不打', async () => {
  const a = await ok(order(alice, { remark: '少冰' }))
  const b = await ok(order(bob, { mode: 'takeaway' }))
  await fails(alice.coffee('ordersForPrint', { ids: [a.id] }), 'FORBIDDEN')
  const list = await ok(barista.coffee('ordersForPrint', { ids: [b.id, a.id, 'nope'] }))
  assert.deepEqual(list.map((o) => o._id), [a.id, b.id], '按取餐号排')
  assert.equal(list[0].remark, '少冰')
  assert.equal(list[0].items[0].subtotal > 0, true)
  assert.equal(list[0]._openid, undefined)
  await setDoc('coffee_orders', b.id, { awaitingPay: true })
  assert.deepEqual((await ok(barista.coffee('ordersForPrint', { ids: [a.id, b.id] }))).map((o) => o._id), [a.id])
  assert.deepEqual(await ok(barista.coffee('ordersForPrint', { ids: 'x' })), [])
})

test('通知设置：只有店主能改；从公众平台的模板里选，存下字段怎么填', async () => {
  await fails(barista.common('getNotifySettings'), 'FORBIDDEN')
  let s = await ok(owner.common('getNotifySettings'))
  assert.equal(s.orderReady, null)
  assert.equal(s.state, 'formal')
  assert.deepEqual(s.templates.map((t) => t.title), ['取餐提醒', '订单完成通知', '到期提醒'])
  assert.deepEqual(s.templates[0].fields, ['取餐号', '商品名称', '门店名称', '温馨提示'])
  assert.equal((await ok(alice.coffee('quote', { items: [{ productId: cake()._id, qty: 1 }] }))).notifyTemplate, '', '没配模板时不请顾客订阅')

  await fails(owner.common('saveNotifySettings', { orderReady: 'TPL_GONE' }))
  s = await ok(owner.common('saveNotifySettings', { orderReady: 'TPL_PICKUP', rentalDue: 'TPL_DUE', state: 'developer' }))
  assert.equal(s.state, 'developer')
  assert.equal(s.orderReady.title, '取餐提醒')
  assert.deepEqual(s.orderReady.preview.map((p) => [p.label, p.value]), [
    ['取餐号', '012'],
    ['商品名称', '拿铁 等 3 件'],
    ['门店名称', '进山咖啡'],
    ['温馨提示', '做好了，请到吧台报取餐号 012']
  ])
  assert.equal(s.rentalDue.preview[0].value, '《海贼王 1》')
  assert.equal(s.rentalDue.preview[1].value, '0815')

  // 读不到模板（比如服务器没配 AppSecret）时给出原因，不报错
  const saved = state.templates
  state.templates = null
  s = await ok(owner.common('getNotifySettings'))
  assert.ok(s.templatesError)
  assert.equal(s.orderReady.title, '取餐提醒', '已经存的设置照样显示')
  state.templates = saved
})

test('取餐通知：顾客下单时允许了，店员点做好就发；没允许的不发', async () => {
  const q = await ok(alice.coffee('quote', { items: [{ productId: cake()._id, qty: 1 }] }))
  assert.equal(q.notifyTemplate, 'TPL_PICKUP')
  state.sent = []
  const yes = await ok(order(alice, { tableNo: '', subscribed: true }))
  const no = await ok(order(bob, { mode: 'takeaway' }))
  for (const id of [yes.id, no.id]) {
    await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
    await flush()
    await ok(barista.coffee('setOrderStatus', { id, status: 'done' }))
  }
  await flush()
  assert.equal(state.sent.length, 1, '只给允许了的发，开始制作时不发')
  const msg = state.sent[0]
  const doc = await getDoc('coffee_orders', yes.id)
  assert.equal(msg.touser, 'ALICE')
  assert.equal(msg.templateId, 'TPL_PICKUP')
  assert.equal(msg.page, 'pages/order-detail/order-detail?id=' + yes.id)
  assert.equal(msg.miniprogramState, 'developer')
  assert.deepEqual(msg.data, {
    character_string1: { value: doc.pickupNo },
    thing2: { value: '拿铁 等 3 件' },
    thing3: { value: '进山咖啡' },
    thing4: { value: '做好了，请到吧台报取餐号 ' + doc.pickupNo }
  })
})

test('取餐通知发不出去（顾客没允许、次数用完）也不影响出餐', async () => {
  const { id } = await ok(order(alice, { subscribed: true }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  state.sendError = 43101
  const before = state.sent.length
  await ok(barista.coffee('setOrderStatus', { id, status: 'done' }))
  await flush()
  state.sendError = 0
  assert.equal(state.sent.length, before)
  assert.equal((await getDoc('coffee_orders', id)).status, 'done')
})

test('换成「订单完成通知」模板：订单号、状态、时间、备注自动填', async () => {
  await ok(owner.common('saveNotifySettings', { orderReady: 'TPL_DONE', rentalDue: 'TPL_DUE', state: 'formal' }))
  const { id } = await ok(order(bob, { mode: 'takeaway', subscribed: true }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'done' }))
  await flush()
  const msg = state.sent[state.sent.length - 1]
  const doc = await getDoc('coffee_orders', id)
  assert.equal(msg.miniprogramState, 'formal')
  assert.equal(msg.data.character_string1.value, doc.orderNo)
  assert.equal(msg.data.phrase2.value, '已做好')
  assert.match(msg.data.time3.value, /^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
})

// 先用洗车小程序的顾客，用户 id 是洗车小程序里的 openid；咖啡的通知要发到咖啡小程序里的 openid
test('先用洗车后用咖啡的顾客：取餐通知发到咖啡小程序的 openid', async () => {
  await db.collection('wx_users').add({ data: { _id: 'U_DAVE', uid: 'CW_DAVE', openids: { carwash: 'CW_DAVE', coffee: 'CF_DAVE' } } })
  const dave = as('CW_DAVE', { app: 'coffee', appOpenid: 'CF_DAVE', unionid: 'U_DAVE' })
  const { id } = await ok(order(dave, { mode: 'takeaway', subscribed: true }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
  await ok(barista.coffee('setOrderStatus', { id, status: 'done' }))
  await flush()
  assert.equal((await getDoc('coffee_orders', id))._openid, 'CW_DAVE')
  assert.equal(state.sent[state.sent.length - 1].touser, 'CF_DAVE')
})

const hourly = () => shelf.rules.find((r) => r.type === 'hourly')
const dayRule = () => shelf.rules.find((r) => r.type === 'day')
const book = (title) => shelf.books.find((b) => b.title === title)

test('借书到期提醒：按小时借、允许了的，到期前 10 分钟提醒一次', async () => {
  const detail = await ok(alice.book('getBook', { id: book('瓦尔登湖')._id }))
  assert.equal(detail.notifyTemplate, 'TPL_DUE')
  const a = await ok(alice.book('createRental', { bookId: book('瓦尔登湖')._id, ruleId: hourly()._id, hours: 1, subscribed: true }))
  const b = await ok(bob.book('createRental', { bookId: book('小王子')._id, ruleId: dayRule()._id, subscribed: true }))
  assert.equal((await getDoc('book_rentals', a.id)).notifyDue, true)
  assert.equal((await getDoc('book_rentals', b.id)).notifyDue, undefined, '包天的打烊前还，不提醒')
  for (const id of [a.id, b.id]) {
    await ok(owner.book('markRentalPaid', { id }))
    await ok(owner.book('handOut', { id }))
  }
  state.sent = []
  assert.equal(await modules.book.remindDue(), 0, '还有 1 小时，不提醒')
  await setDoc('book_rentals', a.id, { dueAt: new Date(Date.now() + 8 * 60000) })
  assert.equal(await modules.book.remindDue(), 1)
  assert.equal(await modules.book.remindDue(), 0, '只提醒一次')
  const msg = state.sent[0]
  const rental = await getDoc('book_rentals', a.id)
  assert.equal(msg.touser, 'ALICE')
  assert.equal(msg.page, 'pages/rental-detail/rental-detail?id=' + a.id)
  assert.equal(msg.data.thing1.value, '《瓦尔登湖》')
  assert.equal(msg.data.character_string4.value, rental.code)
  assert.equal(msg.data.thing3.value, '快到时间了，看完请还到吧台')
})

test('已经过了到期时间才想起来提醒的（服务器停过）不再发', async () => {
  const rid = (await ok(bob.book('createRental', { bookId: book('人间词话')._id, ruleId: hourly()._id, hours: 2, subscribed: true }))).id
  await ok(owner.book('markRentalPaid', { id: rid }))
  await ok(owner.book('handOut', { id: rid }))
  await setDoc('book_rentals', rid, { dueAt: new Date(Date.now() - 60000) })
  const before = state.sent.length
  assert.equal(await modules.book.remindDue(), 0)
  assert.equal(state.sent.length, before)
  assert.equal((await getDoc('book_rentals', rid)).dueReminded, true)
})

test('关掉通知：模板清空后不再请顾客订阅', async () => {
  await ok(owner.common('saveNotifySettings', { orderReady: '', rentalDue: '' }))
  assert.equal((await ok(alice.coffee('quote', { items: [{ productId: cake()._id, qty: 1 }] }))).notifyTemplate, '')
  assert.equal((await ok(alice.book('getBook', { id: book('小王子')._id }))).notifyTemplate, '')
})
