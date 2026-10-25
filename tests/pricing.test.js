const test = require('node:test')
const assert = require('node:assert/strict')
const { buildLines, sanitizeSpecs } = require('../server/functions/pricing')
const { cnDay, cleanText } = require('../server/functions/base')

const latte = {
  _id: 'p1',
  name: '拿铁',
  price: 2200,
  onShelf: true,
  soldOut: false,
  specs: [
    { name: '杯型', options: [{ name: '中杯', price: 0 }, { name: '大杯', price: 300 }] },
    { name: '温度', options: [{ name: '热', price: 0 }, { name: '冰', price: 0 }] }
  ]
}
const pourOver = { _id: 'p2', name: '手冲', price: 3200, onShelf: true, soldOut: false, specs: [] }

test('按数据库价格和规格加价算总价，忽略前端传的价格', () => {
  const { lines, total } = buildLines([latte, pourOver], [
    { productId: 'p1', qty: 2, unitPrice: 1, specs: [{ name: '杯型', option: '大杯' }, { name: '温度', option: '冰' }] },
    { productId: 'p2', qty: 1 }
  ])
  assert.equal(total, (2200 + 300) * 2 + 3200)
  assert.equal(lines[0].unitPrice, 2500)
  assert.deepEqual(lines[0].specs, [{ name: '杯型', option: '大杯' }, { name: '温度', option: '冰' }])
})

test('规格没选全或选了不存在的选项会提示菜单有变化', () => {
  assert.throws(() => buildLines([latte], [{ productId: 'p1', qty: 1, specs: [{ name: '杯型', option: '大杯' }] }]), { code: 'MENU_CHANGED' })
  assert.throws(() => buildLines([latte], [{ productId: 'p1', qty: 1, specs: [{ name: '杯型', option: '超大杯' }, { name: '温度', option: '热' }] }]), { code: 'MENU_CHANGED' })
})

test('下架、售罄、数量不对都不能下单', () => {
  assert.throws(() => buildLines([Object.assign({}, pourOver, { onShelf: false })], [{ productId: 'p2', qty: 1 }]), { code: 'MENU_CHANGED' })
  assert.throws(() => buildLines([Object.assign({}, pourOver, { soldOut: true })], [{ productId: 'p2', qty: 1 }]), { code: 'MENU_CHANGED' })
  assert.throws(() => buildLines([pourOver], [{ productId: 'p2', qty: 0 }]))
  assert.throws(() => buildLines([pourOver], [{ productId: 'p2', qty: 1.5 }]))
  assert.throws(() => buildLines([pourOver], []))
})

test('整理规格：去空白、校验加价、拒绝重复', () => {
  const specs = sanitizeSpecs([{ name: ' 杯型 ', options: [{ name: '中杯', price: 0 }, { name: '大杯', price: 300 }] }])
  assert.deepEqual(specs, [{ name: '杯型', options: [{ name: '中杯', price: 0 }, { name: '大杯', price: 300 }] }])
  assert.deepEqual(sanitizeSpecs(undefined), [])
  assert.throws(() => sanitizeSpecs([{ name: '杯型', options: [{ name: '中杯', price: 1.5 }] }]))
  assert.throws(() => sanitizeSpecs([{ name: '杯型', options: [{ name: '中杯' }, { name: '中杯' }] }]))
  assert.throws(() => sanitizeSpecs([{ name: '杯型', options: [] }]))
  assert.throws(() => sanitizeSpecs([{ name: 'a', options: [{ name: 'x' }] }, { name: 'a', options: [{ name: 'y' }] }]))
})

test('取餐号按中国时间换日', () => {
  assert.equal(cnDay(Date.UTC(2026, 9, 24, 15, 59)), '2026-10-24')
  assert.equal(cnDay(Date.UTC(2026, 9, 24, 16, 0)), '2026-10-25')
})

test('cleanText 截断中文按字符算', () => {
  assert.equal(cleanText('  进山\n咖啡  ', 10), '进山 咖啡')
  assert.equal(cleanText('一二三四五六', 3), '一二三')
  assert.equal(cleanText(null, 3), '')
})
