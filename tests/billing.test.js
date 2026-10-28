// 借书计费和赠饮券抵扣的纯逻辑
const test = require('node:test')
const assert = require('node:assert/strict')
require('./helpers/load')
const { sanitizeRule, quoteRental, dueAt, overtime, ruleSummary } = require('../server/functions/billing')
const { applyVouchers } = require('../server/functions/pricing')

const MIN = 60000
const HOUR = 60 * MIN

test('规则校验：按小时', () => {
  const r = sanitizeRule({ type: 'hourly', name: ' 按小时 ', price: 800 })
  assert.equal(r.name, '按小时')
  assert.equal(r.minHours, 1)
  assert.equal(r.maxHours, 8)
  assert.equal(r.graceMinutes, 10)
  assert.equal(r.freeCups, 0)
  assert.throws(() => sanitizeRule({ type: 'hourly', name: 'x', price: 0 }), /不能是 0/)
  assert.throws(() => sanitizeRule({ type: 'hourly', name: 'x', price: 8.5 }), /价格不对/)
  assert.throws(() => sanitizeRule({ type: 'hourly', name: 'x', price: 800, minHours: 4, maxHours: 2 }), /最多小时数/)
  assert.throws(() => sanitizeRule({ type: 'weekly', name: 'x', price: 800 }), /计费方式/)
  assert.throws(() => sanitizeRule({ type: 'hourly', name: '', price: 800 }), /名称/)
})

test('规则校验：包天送咖啡', () => {
  const r = sanitizeRule({
    type: 'day',
    name: '包天',
    price: 3900,
    freeCups: 2,
    freeProducts: [{ id: 'p1', name: '拿铁' }, { id: 'p1', name: '重复' }, { id: '', name: '空' }, { id: 'p2', name: '美式' }],
    freeMaxFee: 2500,
    minHours: 3
  })
  assert.equal(r.minHours, 0, '包天不需要小时数')
  assert.deepEqual(r.freeProducts, [{ id: 'p1', name: '拿铁' }, { id: 'p2', name: '美式' }])
  assert.equal(r.freeMaxFee, 2500)
  const none = sanitizeRule({ type: 'day', name: '包天', price: 3900, freeCups: 0, freeProducts: [{ id: 'p1', name: '拿铁' }] })
  assert.deepEqual(none.freeProducts, [], '不送咖啡时清掉赠饮商品')
  assert.throws(() => sanitizeRule({ type: 'day', name: '包天', price: 3900, freeCups: 6 }), /赠送杯数/)
  assert.equal(ruleSummary(r), '¥39/天，送 2 杯饮品')
  assert.equal(ruleSummary(sanitizeRule({ type: 'hourly', name: 'x', price: 850, minHours: 2 })), '¥8.5/小时，2 小时起')
})

test('租金：按小时按选的小时数，包天固定价', () => {
  const hourly = sanitizeRule({ type: 'hourly', name: 'x', price: 800, minHours: 2, maxHours: 6 })
  assert.deepEqual(quoteRental(hourly, 3), { hours: 3, fee: 2400 })
  assert.throws(() => quoteRental(hourly, 1), /2 到 6 小时/)
  assert.throws(() => quoteRental(hourly, 7))
  assert.throws(() => quoteRental(hourly, 2.5))
  const day = sanitizeRule({ type: 'day', name: 'x', price: 3900 })
  assert.deepEqual(quoteRental(day, 99), { hours: 0, fee: 3900 })
})

test('到期时间：按小时从交书开始算，包天到当天 24 点（北京时间）', () => {
  const start = Date.parse('2026-10-24T10:00:00+08:00')
  assert.equal(dueAt({ ruleType: 'hourly', hours: 2 }, start), start + 2 * HOUR)
  assert.equal(dueAt({ ruleType: 'day' }, start), Date.parse('2026-10-24T23:59:59.999+08:00'))
  // 北京时间凌晨（UTC 还是前一天）也按北京时间的当天算
  const early = Date.parse('2026-10-25T01:00:00+08:00')
  assert.equal(dueAt({ ruleType: 'day' }, early), Date.parse('2026-10-25T23:59:59.999+08:00'))
})

test('超时费：宽限内不收，超过按小时补，不满一小时算一小时', () => {
  const due = Date.parse('2026-10-24T12:00:00+08:00')
  const rental = { ruleType: 'hourly', unitPrice: 800, graceMinutes: 10, dueAt: new Date(due) }
  assert.deepEqual(overtime(rental, due - 5 * MIN), { minutes: 0, hours: 0, fee: 0 })
  assert.deepEqual(overtime(rental, due + 10 * MIN), { minutes: 0, hours: 0, fee: 0 })
  assert.deepEqual(overtime(rental, due + 11 * MIN), { minutes: 11, hours: 1, fee: 800 })
  assert.deepEqual(overtime(rental, due + 75 * MIN), { minutes: 75, hours: 2, fee: 1600 })
  assert.deepEqual(overtime(Object.assign({}, rental, { dueAt: new Date(due).toISOString() }), due + 61 * MIN).fee, 1600)
  assert.equal(overtime({ ruleType: 'day', dueAt: new Date(due) }, due + 5 * HOUR).fee, 0, '包天没有超时费')
})

const line = (productId, unitPrice, qty) => ({ productId, name: productId, unitPrice, qty })

test('赠饮券：每张抵一杯，挑最贵的；限定商品的券优先', () => {
  const lines = [line('latte', 2500, 1), line('americano', 1800, 2), line('cake', 2800, 1)]
  const any = { _id: 'v-any', productIds: [], maxFee: 0 }
  const coffeeOnly = { _id: 'v-coffee', productIds: ['latte', 'americano'], maxFee: 0 }
  const r1 = applyVouchers(lines, [any, coffeeOnly])
  // 限定券先挑拿铁，通用券再挑最贵的蛋糕
  assert.deepEqual(r1.applied.map((a) => [a.id, a.productId, a.discount]), [['v-coffee', 'latte', 2500], ['v-any', 'cake', 2800]])
  assert.equal(r1.discount, 5300)

  const capped = applyVouchers(lines, [{ _id: 'v1', productIds: ['americano'], maxFee: 1500 }, { _id: 'v2', productIds: ['americano'], maxFee: 1500 }, { _id: 'v3', productIds: ['americano'], maxFee: 1500 }])
  assert.equal(capped.applied.length, 2, '两杯美式只能用两张')
  assert.equal(capped.discount, 3000, '每杯最多抵 15 元')

  const none = applyVouchers(lines, [{ _id: 'v', productIds: ['matcha'], maxFee: 0 }])
  assert.deepEqual(none, { applied: [], discount: 0, covered: [0, 0, 0] }, '用不上的券不算')

  // 接着上一轮算：已经抵掉的杯不会再被抵，传进来的数组不被改
  assert.deepEqual(r1.covered, [1, 0, 1])
  const next = applyVouchers(lines, [any, any], r1.covered)
  assert.deepEqual(next.applied.map((a) => a.productId), ['americano', 'americano'])
  assert.deepEqual(next.covered, [1, 2, 1])
  assert.deepEqual(r1.covered, [1, 0, 1])
})
