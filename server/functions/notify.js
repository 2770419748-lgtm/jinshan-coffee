// 订阅消息：出餐时通知顾客取餐，按小时借书快到期时提醒顾客。
// 店主先在公众平台「订阅消息」里从模板库选好模板，再到网页后台「消息通知」里指定用哪个。
// 模板库里同一类模板的字段各不相同，这里按字段名称（取餐号、商品名称、温馨提示……）自动决定填什么，
// 再按字段类型（thing 20 个字以内、phrase 5 个汉字以内……）截成微信接受的格式。
// 微信的规矩：顾客点一次「允许」只能收一条，所以每次下单、借书时都要问一次。
const cloud = require('../platform')
const { BizError, getStaff } = require('./base')
const { appOpenid } = require('../lib/identity')

const SHOP_NAME = '进山咖啡'
const KINDS = { orderReady: '取餐通知', rentalDue: '借书到期提醒' }
// 点消息打开哪个版本：正式版、体验版、开发版（小程序还没发布时用后两个测试）
const STATES = ['formal', 'trial', 'developer']
// 借书到期前多少分钟提醒
const DUE_REMIND_MINUTES = 10

// 字段名称 → 填什么。按顺序匹配，先匹配到的算
const RULES = {
  orderReady: [
    [/取餐号|取餐码|取单号|取货码|取件码|排队号|叫号|号码/, 'pickupNo'],
    [/订单号|订单编号|单号/, 'orderNo'],
    [/下单时间|订单时间|下单日期/, 'orderTime'],
    [/门店|店铺|店名|商家|地点|地址|取餐处/, 'shop'],
    [/桌/, 'table'],
    [/商品|菜品|餐品|饮品|菜名|内容|详情|名称/, 'items'],
    [/状态|进度/, 'status'],
    [/金额|实付|价格|费用|合计/, 'amount'],
    [/数量|件数|份数/, 'qty'],
    [/时间|日期/, 'time'],
    [/提示|备注|说明|提醒/, 'tip']
  ],
  rentalDue: [
    [/借阅号|借书号|取书号|编号|单号/, 'code'],
    [/门店|店铺|店名|商家|地点|地址/, 'shop'],
    [/剩余|还剩/, 'left'],
    [/开始|借阅时间|取书时间|借出/, 'start'],
    [/到期|截止|结束|归还|还书/, 'due'],
    [/书|物品|商品|名称|项目|内容/, 'book'],
    [/状态|进度/, 'status'],
    [/金额|费用|价格/, 'amount'],
    [/时间|日期/, 'due'],
    [/提示|备注|说明|提醒/, 'tip']
  ]
}
// 名称没对上时按字段类型兜底
const BY_TYPE = {
  orderReady: { thing: 'tip', phrase: 'status', character_string: 'orderNo', number: 'pickupNo', time: 'time', date: 'time', amount: 'amount', name: 'shop' },
  rentalDue: { thing: 'tip', phrase: 'status', character_string: 'code', number: 'code', time: 'due', date: 'due', amount: 'amount', name: 'shop' }
}
const LABELS = {
  pickupNo: '取餐号', orderNo: '订单号', orderTime: '下单时间', shop: '店名', table: '桌号', items: '点了什么', status: '状态',
  amount: '金额', qty: '件数', time: '现在的时间', tip: '提示', code: '借书号', left: '剩余时间', start: '取书时间', due: '到期时间', book: '书名'
}

async function readSettings(db) {
  const res = await db.collection('settings').where({ _id: 'notify' }).limit(1).get()
  const s = res.data[0] || {}
  return {
    state: STATES.indexOf(s.state) === -1 ? 'formal' : s.state,
    orderReady: s.orderReady && s.orderReady.templateId ? s.orderReady : null,
    rentalDue: s.rentalDue && s.rentalDue.templateId ? s.rentalDue : null
  }
}

// 小程序下单、借书时要请求订阅的模板 ID
async function templateIds(db) {
  const s = await readSettings(db)
  return { orderReady: s.orderReady ? s.orderReady.templateId : '', rentalDue: s.rentalDue ? s.rentalDue.templateId : '' }
}

// 「取餐号:{{character_string1.DATA}}」→ { key: 'character_string1', label: '取餐号', type: 'character_string' }
function parseFields(content) {
  const fields = []
  const re = /([^{}\n]*?)\{\{\s*([a-z_]+?)(\d+)\.DATA\s*\}\}/g
  let m
  while ((m = re.exec(String(content || '')))) {
    fields.push({ key: m[2] + m[3], label: m[1].replace(/[:：\s]+$/g, '').trim(), type: m[2] })
  }
  return fields
}

function mapFields(kind, fields) {
  return fields.map((f) => {
    const rule = RULES[kind].find(([re]) => re.test(f.label))
    return Object.assign({}, f, { use: rule ? rule[1] : BY_TYPE[kind][f.type] || 'tip' })
  })
}

const pad = (n) => (n < 10 ? '0' + n : '' + n)

function cnTime(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
}

function yuanText(fen) {
  return '¥' + ((fen || 0) / 100).toFixed(2)
}

const chars = (s) => Array.from(String(s))

// 一个值：{ text } 文字、{ ms } 时间、{ fen } 金额。按字段类型转成微信接受的样子，不能是空的
function format(value, type) {
  const v = value || {}
  const text = v.ms !== undefined ? cnTime(v.ms) : v.fen !== undefined ? yuanText(v.fen) : String(v.text || '')
  switch (type) {
    case 'time':
    case 'date':
      return v.ms !== undefined ? cnTime(v.ms) : cnTime(Date.now())
    case 'amount':
      return v.fen !== undefined ? yuanText(v.fen) : '¥0.00'
    case 'number':
      return (text.match(/\d+/g) || ['0']).join('').slice(0, 32)
    case 'character_string':
      return chars(text.replace(/[^\x21-\x7e]/g, '')).slice(0, 32).join('') || '-'
    case 'letter':
      return text.replace(/[^A-Za-z]/g, '').slice(0, 32) || 'JINSHAN'
    case 'symbol':
      return '-'
    case 'phrase':
      return chars(text.replace(/[^一-龥]/g, '')).slice(0, 5).join('') || '已完成'
    case 'name':
      return chars(text).slice(0, 10).join('') || SHOP_NAME
    default:
      return chars(text).slice(0, 20).join('') || '-'
  }
}

function buildData(fields, values) {
  const data = {}
  fields.forEach((f) => { data[f.key] = { value: format(values[f.use], f.type) } })
  return data
}

function orderValues(order) {
  const items = order.items || []
  const first = items[0] ? items[0].name : '饮品'
  const count = items.reduce((n, l) => n + l.qty, 0)
  return {
    pickupNo: { text: order.pickupNo },
    orderNo: { text: order.orderNo },
    orderTime: { ms: new Date(order.createdAt).getTime() },
    shop: { text: SHOP_NAME },
    table: { text: order.tableNo ? order.tableNo + ' 号桌' : '外带' },
    items: { text: count > 1 ? first + ' 等 ' + count + ' 件' : first },
    status: { text: '已做好' },
    amount: { fen: order.payFee },
    qty: { text: String(count) },
    time: { ms: Date.now() },
    tip: { text: '做好了，请到吧台报取餐号 ' + order.pickupNo }
  }
}

function rentalValues(rental) {
  const due = new Date(rental.dueAt).getTime()
  return {
    code: { text: rental.code },
    shop: { text: SHOP_NAME },
    left: { text: Math.max(1, Math.round((due - Date.now()) / 60000)) + ' 分钟' },
    start: { ms: new Date(rental.startAt).getTime() },
    due: { ms: due },
    book: { text: '《' + rental.bookTitle + '》' },
    status: { text: '即将到期' },
    amount: { fen: rental.fee },
    tip: { text: '快到时间了，看完请还到吧台' }
  }
}

// 发一条通知；没配模板、顾客没允许、微信报错都只记日志，不影响出餐和借书。
// uid 是用户 id；先洗车后咖啡的顾客，用户 id 是洗车小程序的 openid，要换成咖啡小程序的才能发
// 测试版的数据是从正式版复制来的，只发给店主和店员（测试的人），点开的是体验版
async function send(db, kind, uid, values, page) {
  const s = await readSettings(db)
  const tpl = s[kind]
  if (!tpl || !uid) return false
  const test = cloud.isTest()
  try {
    if (test && !(await getStaff(db, uid))) {
      console.log('测试版不给顾客发通知', kind)
      return false
    }
    const openid = await appOpenid(db, 'coffee', uid)
    if (!openid) return false
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: tpl.templateId,
      page,
      data: buildData(tpl.fields, values),
      miniprogramState: test && s.state === 'formal' ? 'trial' : s.state
    })
    return true
  } catch (e) {
    // 43101：顾客没允许或者这条已经用掉了，正常情况
    if (e.errCode !== 43101) console.warn('订阅消息发送失败', kind, e.message)
    return false
  }
}

function orderReady(db, order) {
  return send(db, 'orderReady', order._openid, orderValues(order), 'pages/order-detail/order-detail?id=' + order._id)
}

function rentalDue(db, rental) {
  return send(db, 'rentalDue', rental._openid, rentalValues(rental), 'pages/rental-detail/rental-detail?id=' + rental._id)
}

// ---------- 店主设置 ----------

function sampleOrder() {
  return {
    pickupNo: '012', orderNo: 'JS20261026143000123', createdAt: new Date(Date.now() - 10 * 60000), tableNo: '5', payFee: 6400,
    items: [{ name: '拿铁', qty: 2 }, { name: '芝士蛋糕', qty: 1 }]
  }
}

function sampleRental() {
  const now = Date.now()
  return { code: '0815', bookTitle: '海贼王 1', startAt: new Date(now - 50 * 60000), dueAt: new Date(now + 10 * 60000), fee: 1500 }
}

function preview(kind, tpl) {
  if (!tpl) return null
  const values = kind === 'orderReady' ? orderValues(sampleOrder()) : rentalValues(sampleRental())
  const data = buildData(tpl.fields, values)
  return tpl.fields.map((f) => ({ label: f.label, use: LABELS[f.use] || f.use, value: data[f.key].value }))
}

function publicTemplate(t) {
  return { templateId: t.priTmplId, title: t.title, content: t.content, fields: parseFields(t.content).map((f) => f.label) }
}

async function getSettings(db) {
  const s = await readSettings(db)
  let templates = []
  let templatesError = ''
  try {
    templates = (await cloud.openapi.subscribeMessage.getTemplateList()).map(publicTemplate)
  } catch (e) {
    templatesError = '读不到公众平台里的模板：' + (e.errMsg || e.message)
  }
  const out = { state: s.state, templates, templatesError, kinds: KINDS, dueMinutes: DUE_REMIND_MINUTES }
  Object.keys(KINDS).forEach((k) => {
    out[k] = s[k] ? { templateId: s[k].templateId, title: s[k].title, preview: preview(k, s[k]) } : null
  })
  return out
}

async function saveSettings(db, input, openid) {
  const state = STATES.indexOf(input.state) === -1 ? 'formal' : input.state
  const wanted = {}
  Object.keys(KINDS).forEach((k) => { wanted[k] = typeof input[k] === 'string' ? input[k].trim() : '' })
  let list = []
  if (wanted.orderReady || wanted.rentalDue) {
    try {
      list = await cloud.openapi.subscribeMessage.getTemplateList()
    } catch (e) {
      throw new BizError('读不到公众平台里的模板：' + (e.errMsg || e.message))
    }
  }
  const data = { state, updatedBy: openid, updatedAt: db.serverDate() }
  Object.keys(KINDS).forEach((k) => {
    if (!wanted[k]) {
      data[k] = null
      return
    }
    const t = list.find((x) => x.priTmplId === wanted[k])
    if (!t) throw new BizError(KINDS[k] + '的模板在公众平台「我的模板」里找不到，请刷新后重新选')
    const fields = parseFields(t.content)
    if (!fields.length) throw new BizError('「' + t.title + '」这个模板读不出字段，换一个试试')
    data[k] = { templateId: t.priTmplId, title: t.title, fields: mapFields(k, fields) }
  })
  await db.collection('settings').doc('notify').set({ data })
  return getSettings(db)
}

module.exports = {
  KINDS,
  STATES,
  DUE_REMIND_MINUTES,
  readSettings,
  templateIds,
  parseFields,
  mapFields,
  format,
  buildData,
  orderReady,
  rentalDue,
  getSettings,
  saveSettings
}
