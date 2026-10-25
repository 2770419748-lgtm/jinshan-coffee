// 借书计费：规则校验、租金、到期时间、超时费。金额都用“分”存整数。
// 两种计费方式：
//   hourly 按小时：顾客借书时选几个小时并预付；超过到期时间（扣掉宽限分钟）按小时补超时费，不满一小时算一小时
//   day 包天：当天随便看，打烊前还；可以送几杯咖啡，付款后发赠饮券
const { BizError, cleanText, cnDay } = require('./base')

const RULE_TYPES = { hourly: '按小时', day: '包天' }
const MAX_RULE_PRICE = 100000 // 1000 元
const MAX_HOURS = 24
const MAX_FREE_CUPS = 5
const HOUR = 3600 * 1000

function intIn(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

function need(value, message) {
  if (value === null) throw new BizError(message)
  return value
}

// 后台保存规则前整理字段；两种方式的字段都存上，方便统一处理
function sanitizeRule(input) {
  const r = input || {}
  if (!RULE_TYPES[r.type]) throw new BizError('请选择计费方式')
  const name = cleanText(r.name, 16)
  if (!name) throw new BizError('请填写规则名称')
  const price = need(intIn(r.price, 0, MAX_RULE_PRICE, null), '价格不对，请填 0 到 1000 元')
  const rule = {
    name,
    type: r.type,
    price,
    desc: cleanText(r.desc, 60),
    onShelf: r.onShelf !== false,
    sort: Number.isFinite(Number(r.sort)) ? Math.round(Number(r.sort)) : 0,
    minHours: 0,
    maxHours: 0,
    graceMinutes: 0,
    freeCups: 0,
    freeProducts: [],
    freeMaxFee: 0
  }
  if (r.type === 'hourly') {
    if (!price) throw new BizError('按小时计费的每小时价格不能是 0')
    rule.minHours = need(intIn(r.minHours, 1, MAX_HOURS, 1), '最少小时数请填 1 到 ' + MAX_HOURS)
    rule.maxHours = need(intIn(r.maxHours, rule.minHours, MAX_HOURS, Math.max(rule.minHours, 8)), '最多小时数要在 ' + rule.minHours + ' 到 ' + MAX_HOURS + ' 之间')
    rule.graceMinutes = need(intIn(r.graceMinutes, 0, 60, 10), '宽限时间请填 0 到 60 分钟')
  } else {
    rule.freeCups = need(intIn(r.freeCups, 0, MAX_FREE_CUPS, 0), '赠送杯数请填 0 到 ' + MAX_FREE_CUPS)
    const list = Array.isArray(r.freeProducts) ? r.freeProducts : []
    if (list.length > 50) throw new BizError('可选的赠饮商品最多 50 个')
    const seen = {}
    list.forEach((p) => {
      const id = p && typeof p.id === 'string' ? p.id.slice(0, 64) : ''
      if (!id || seen[id]) return
      seen[id] = true
      rule.freeProducts.push({ id, name: cleanText(p.name, 30) })
    })
    rule.freeMaxFee = need(intIn(r.freeMaxFee, 0, MAX_RULE_PRICE, 0), '每杯最多抵扣的金额不对')
    if (!rule.freeCups) {
      rule.freeProducts = []
      rule.freeMaxFee = 0
    }
  }
  return rule
}

// 顾客下单时算租金；hours 只对按小时有效
function quoteRental(rule, hours) {
  if (rule.type === 'day') return { hours: 0, fee: rule.price }
  const h = intIn(hours, rule.minHours || 1, rule.maxHours || MAX_HOURS, null)
  if (h === null) throw new BizError('请选 ' + rule.minHours + ' 到 ' + rule.maxHours + ' 小时')
  return { hours: h, fee: rule.price * h }
}

// 中国时间某天的 23:59:59.999
function endOfCnDay(ms) {
  return Date.parse(cnDay(ms) + 'T23:59:59.999+08:00')
}

// 交书开始计时后的到期时间
function dueAt(rental, startMs) {
  if (rental.ruleType === 'day') return endOfCnDay(startMs)
  return startMs + rental.hours * HOUR
}

// 还书时的超时：分钟数、补几小时、超时费。包天没有超时费。
function overtime(rental, nowMs) {
  const none = { minutes: 0, hours: 0, fee: 0 }
  if (rental.ruleType !== 'hourly' || !rental.dueAt) return none
  const due = rental.dueAt instanceof Date ? rental.dueAt.getTime() : new Date(rental.dueAt).getTime()
  const minutes = Math.ceil((nowMs - due) / 60000)
  if (minutes <= (rental.graceMinutes || 0)) return none
  const hours = Math.ceil(minutes / 60)
  return { minutes, hours, fee: hours * rental.unitPrice }
}

// 给顾客看的价格说明，比如「¥8/小时，1 小时起」「¥39/天，送 1 杯咖啡」
function yuan(fen) {
  return String(Math.round(fen) / 100)
}

function ruleSummary(rule) {
  if (rule.type === 'hourly') {
    return '¥' + yuan(rule.price) + '/小时' + (rule.minHours > 1 ? '，' + rule.minHours + ' 小时起' : '')
  }
  return '¥' + yuan(rule.price) + '/天' + (rule.freeCups ? '，送 ' + rule.freeCups + ' 杯饮品' : '')
}

module.exports = { RULE_TYPES, MAX_HOURS, sanitizeRule, quoteRental, dueAt, overtime, ruleSummary, endOfCnDay }
