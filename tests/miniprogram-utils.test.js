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
