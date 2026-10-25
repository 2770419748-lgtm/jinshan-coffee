// 小程序端的纯逻辑：解析桌码、购物车
const test = require('node:test')
const assert = require('node:assert/strict')

// 用一个内存 storage 模拟 wx
const storage = {}
global.wx = {
  getStorageSync: (k) => storage[k],
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync: (k) => { delete storage[k] }
}

const table = require('../miniprogram/utils/table')
const cart = require('../miniprogram/utils/cart')

test('从小程序码的 scene 和扫码 path 里取桌号', () => {
  assert.equal(table.parseQuery({ scene: 't%3D5' }), '5')
  assert.equal(table.parseQuery({ scene: encodeURIComponent('t=A3') }), 'A3')
  assert.equal(table.parseQuery({ t: '12' }), '12')
  assert.equal(table.parseQuery({ scene: 'x%3D1' }), '')
  assert.equal(table.parseQuery({ t: '<script>' }), '')
  assert.equal(table.parseQuery(null), '')
  assert.equal(table.parsePath('pages/menu/menu?scene=t%3D7'), '7')
  assert.equal(table.parsePath('pages/menu/menu'), '')
})

test('桌号 4 小时后失效', () => {
  table.set('5')
  assert.equal(table.get(), '5')
  storage.jinshan_table.at -= 4 * 3600 * 1000 + 1
  assert.equal(table.get(), '')
})

test('预约点单：2 小时后失效；扫了桌码就不是预约了', () => {
  const reserve = require('../miniprogram/utils/reserve')
  reserve.on()
  assert.equal(reserve.active(), true)
  table.set('3')
  assert.equal(reserve.active(), false)
  reserve.on()
  storage.jinshan_reserve.at -= 2 * 3600 * 1000 + 1
  assert.equal(reserve.active(), false)
  reserve.off()
  table.clear()
})

const latte = {
  _id: 'p1',
  name: '拿铁',
  price: 2200,
  image: '',
  specs: [{ name: '杯型', options: [{ name: '中杯', price: 0 }, { name: '大杯', price: 300 }] }]
}

test('购物车：同商品同规格合并，不同规格分开', () => {
  cart.clear()
  cart.add(latte, [{ name: '杯型', option: '大杯' }], 1)
  cart.add(latte, [{ name: '杯型', option: '大杯' }], 2)
  cart.add(latte, [{ name: '杯型', option: '中杯' }], 1)
  const list = cart.load()
  assert.equal(list.length, 2)
  assert.deepEqual(cart.summary(list), { count: 4, total: 2500 * 3 + 2200 })
  cart.setQty(list[1].key, 0)
  assert.equal(cart.load().length, 1)
})

test('菜单变了：改价跟着变，售罄和规格失效的移出购物车', () => {
  cart.clear()
  cart.add(latte, [{ name: '杯型', option: '大杯' }], 1)
  const pricier = Object.assign({}, latte, { price: 2400 })
  let synced = cart.syncWithMenu(cart.load(), [pricier])
  assert.equal(synced.changed, true)
  assert.equal(synced.list[0].unitPrice, 2700)

  const noLarge = Object.assign({}, latte, { specs: [{ name: '杯型', options: [{ name: '中杯', price: 0 }] }] })
  synced = cart.syncWithMenu(cart.load(), [noLarge])
  assert.equal(synced.list.length, 0)

  synced = cart.syncWithMenu(cart.load(), [Object.assign({}, latte, { soldOut: true })])
  assert.equal(synced.list.length, 0)

  synced = cart.syncWithMenu(cart.load(), [latte])
  assert.equal(synced.changed, false)
})

const money = require('../miniprogram/utils/money')

test('后台表单的元和分互相转换', () => {
  assert.equal(money.textToFen('18'), 1800)
  assert.equal(money.textToFen('18.5'), 1850)
  assert.equal(money.textToFen(' 0.01 '), 1)
  assert.equal(money.textToFen(''), 0)
  assert.equal(money.textToFen('18.555'), null)
  assert.equal(money.textToFen('-1'), null)
  assert.equal(money.textToFen('abc'), null)
  assert.equal(money.fenToText(1850), '18.5')
  assert.equal(money.fenToText(0), '0')
})

// WXS 只支持 ES5：不能有 let、const、箭头函数、模板字符串
const fs = require('fs')
const path = require('path')
const wxsSource = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/filters.wxs'), 'utf8')
const wxs = { exports: {} }
new Function('module', 'getDate', 'getRegExp', wxsSource)(wxs, (...a) => new Date(...a), (s, f) => new RegExp(s, f))

test('filters.wxs 只用 ES5 写法', () => {
  const code = wxsSource.replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\b(let|const)\s/)
  assert.doesNotMatch(code, /=>/)
  assert.doesNotMatch(code, /`/)
})

test('时间按北京时间显示，电脑设成别的时区也一样', async () => {
  const before = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const at = '2026-10-25T08:39:06.000Z'
    const f = wxs.exports
    assert.equal(f.time(at), '10-25 16:39')
    assert.equal(f.clock(at), '16:39')
    assert.equal(f.time('2026-10-25T16:05:00.000Z'), '10-26 00:05', '北京时间过了零点算第二天')
    assert.equal(f.time(''), '')
    const web = await import('../admin-web/src/format.js')
    assert.equal(web.time(at), '10-25 16:39')
    assert.equal(web.clock(new Date(at)), '16:39')
    assert.equal(web.time('not a date'), '')
    assert.equal(web.cnDay(Date.parse('2026-10-25T16:05:00.000Z')), '2026-10-26')
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

test('后台列表的收款状态', () => {
  const f = wxs.exports
  assert.equal(f.payTag('paid', 'wechat'), '微信已付')
  assert.equal(f.payTag('paid', 'voucher'), '券抵扣')
  assert.equal(f.payTag('paid', 'counter'), '已收款')
  assert.equal(f.payTag('refunded', 'wechat'), '已退款')
  assert.equal(f.payTag('unpaid'), '未收款')
})

const loginScene = require('../miniprogram/utils/login-scene')

test('扫码登录：从小程序码的 scene 和扫码 path 里取登录码', () => {
  const id = 'Ab3dEf6hIj9kLm2nOp5q'
  assert.equal(loginScene.parseQuery({ scene: encodeURIComponent('w=' + id) }), id)
  assert.equal(loginScene.parseQuery({ id }), id)
  assert.equal(loginScene.parseQuery({ id: 'short' }), '')
  assert.equal(loginScene.parseQuery({ scene: encodeURIComponent('t=5') }), '')
  assert.equal(loginScene.parseQuery(null), '')
  assert.equal(loginScene.parsePath('admin/pages/web-login/web-login?scene=' + encodeURIComponent('w=' + id)), id)
  assert.equal(loginScene.parsePath('pages/menu/menu?scene=t%3D7'), '')
  assert.equal(loginScene.parsePath(''), '')
})
