// 洗车会员：储值（余额、充值档位、在线充值、到店代充）、次卡（种类、购买、用卡、退卡）、流水。
// 余额用 wallet.js 同一套账本代码，但记在洗车自己的 cw_members、cw_member_logs 里：两家执照、商户号不同，钱分开算，
// 洗车充的钱只能洗车用。会员号和咖啡通用（用 members 里的那个号）。
// 次卡：cw_card_types 是卡的种类（店长配价格、次数、有效天数、能洗哪些项目），cw_cards 是顾客手里的卡，cw_card_logs 是每一次增减。
// 用卡都走 useCard()：排队执行，剩余次数不会扣成负数；带了请求号的，同一个请求号只扣一次（连点两下不会扣两次）。
// 充值成功、办卡成功按送券规则送咖啡券（见 voucher-link.js）。这里的操作都挂在 /api/carwash 下（见 carwash.js）。
const cloud = require('../platform')
const {
  CARWASH_ROLES,
  CARWASH_STAFF,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  requireRole,
  dayRange,
  fetchAll
} = require('./base')
const wallet = require('./wallet')
const pay = require('./pay')
const link = require('./voucher-link')
const shop = require('./carwash-shop')
const { yuan, publicPlan, createPlanStore } = require('./plans')

const db = cloud.database()
const _ = db.command

const SHOP = 'carwash'
const MEMBER_SETTINGS_ID = 'carwash_member'
// 在线充值、在线办卡 15 分钟内付款
const PAY_MINUTES = 15
const MAX_CARD_TYPES = 30
const MAX_CARD_PRICE = 1000000
const MAX_CARD_TIMES = 999
const MAX_CARD_DAYS = 3650
// 店长手动调整一次最多 1 万元
const MAX_ADJUST = 1000000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const NONCE_RE = /^[A-Za-z0-9_-]{8,40}$/
const CARD_LOG_TYPES = { buy: '办卡', use: '用卡', return: '退回', adjust: '店长调整', refund: '退卡' }
const CARD_SOURCES = { wechat: '微信支付', balance: '余额', counter: '到店付款' }

const col = (name) => db.collection(name)
const plans = createPlanStore(db, 'cw_plans')

async function safeList(query) {
  try {
    return (await query.get()).data
  } catch (e) {
    if (isMissingCollection(e)) return []
    throw e
  }
}

async function findOne(name, where) {
  return (await safeList(col(name).where(where).limit(1)))[0] || null
}

async function readMemberSettings() {
  const s = (await findOne('settings', { _id: MEMBER_SETTINGS_ID })) || {}
  return { enabled: !!s.enabled, notice: s.notice || '', refundNotice: s.refundNotice || '' }
}

// 洗车的账：余额记在 cw_members，会员号借咖啡的
const ledger = wallet.createLedger({ members: 'cw_members', logs: 'cw_member_logs', numberFrom: wallet.coffee, readSettings: readMemberSettings })

// 现在能怎么付：wechat 微信支付（店长打开了，服务器上也配好了洗车商户号）、member 会员余额、later 到店付款
async function payWays() {
  const [s, m] = await Promise.all([shop.readSettings(db), readMemberSettings()])
  return { wechat: !!(s.payEnabled && cloud.payOf(SHOP).ready()), member: m.enabled, later: s.payLater }
}

function staffName(staff) {
  return (staff && staff.name) || ''
}

function makeNo(prefix) {
  return prefix + cnStamp() + String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

// 按会员号找洗车的会员；只在咖啡那边有号的（还没打开过洗车会员中心），这时给他开上洗车的账
async function memberByNo(memberNo) {
  try {
    return await ledger.findByNo(db, memberNo)
  } catch (e) {
    if (e.code !== 'MEMBER_NOT_FOUND' || !wallet.MEMBER_NO_RE.test(String(memberNo || '').trim())) throw e
  }
  const base = await wallet.coffee.findByNo(db, memberNo)
  return ledger.ensureMember(db, base._id)
}

// ---------- 次卡 ----------

function cardState(card, today) {
  if (card.status === 'refunded') return 'refunded'
  if (card.expiresDay && card.expiresDay < (today || cnDay())) return 'expired'
  if (!(card.remaining > 0)) return 'used_up'
  return 'active'
}

const CARD_STATE_TEXT = { active: '可用', expired: '已过期', used_up: '已用完', refunded: '已退卡' }

function publicCard(card, today) {
  const state = cardState(card, today)
  return {
    _id: card._id,
    name: card.name,
    total: card.total,
    remaining: card.remaining,
    expiresDay: card.expiresDay || '',
    serviceIds: card.serviceIds || [],
    serviceNames: card.serviceNames || [],
    state,
    stateText: CARD_STATE_TEXT[state],
    price: card.price,
    createdAt: card.createdAt
  }
}

function publicCardLog(l, staffView) {
  const out = {
    _id: l._id,
    cardId: l.cardId,
    type: l.type,
    typeName: CARD_LOG_TYPES[l.type] || l.type,
    title: l.title,
    change: l.change,
    remaining: l.remaining,
    reason: l.reason || '',
    createdAt: l.createdAt
  }
  if (staffView) {
    out.memberNo = l.memberNo
    out.operatorName = l.operatorName || ''
    out.refNo = l.refNo || ''
  }
  return out
}

async function addCardLog(card, entry) {
  const data = Object.assign({
    cardId: card._id,
    _openid: card._openid,
    memberNo: card.memberNo,
    title: '',
    refType: '',
    refId: '',
    refNo: '',
    operator: '',
    operatorName: '',
    reason: '',
    day: cnDay(),
    createdAt: new Date()
  }, entry)
  data.title = cleanText(data.title, 40)
  data.reason = cleanText(data.reason, 40)
  await col('cw_card_logs').add({ data })
}

async function serviceNames(ids) {
  if (!ids || !ids.length) return []
  const list = await safeList(col('cw_services').where({ _id: _.in(ids) }).limit(100))
  return ids.map((id) => (list.find((s) => s._id === id) || {}).name).filter(Boolean)
}

// 给顾客开一张卡。refNo 是这次办卡的单号，同一个单号只开一张（_id 由它算出来）
async function issueCard({ openid, memberNo, type, source, refNo, operator, operatorName }) {
  const id = 'card_' + refNo
  const today = cnDay()
  const card = {
    _openid: openid,
    memberNo,
    typeId: type._id,
    name: type.name,
    serviceIds: type.serviceIds || [],
    serviceNames: await serviceNames(type.serviceIds),
    total: type.times,
    remaining: type.times,
    expiresDay: type.validDays ? wallet.addDays(today, type.validDays - 1) : '',
    status: 'active',
    price: type.price,
    source,
    refNo,
    createdAt: new Date(),
    updatedAt: new Date()
  }
  try {
    await col('cw_cards').add({ data: Object.assign({ _id: id }, card) })
  } catch (e) {
    if (!/duplicate key/.test(String(e && e.message))) throw e
    return Object.assign({ _id: id }, await findOne('cw_cards', { _id: id }))
  }
  const saved = Object.assign({ _id: id }, card)
  await addCardLog(saved, {
    type: 'buy',
    change: type.times,
    remaining: type.times,
    title: '办卡 ' + type.name + '（' + CARD_SOURCES[source] + '）',
    refType: 'card',
    refNo,
    operator: operator || '',
    operatorName: operatorName || ''
  })
  await link.issue(db, { trigger: 'card', openid, refNo, cardTypeId: type._id })
  return saved
}

// 用一次卡。o：{ cardId, openid（只能用自己的卡时传）, serviceId（检查这张卡能不能洗这个）, nonce（请求号，防连点）,
// title, refType, refId, refNo, operator, operatorName }。返回 { remaining, duplicate }
function useCard(o) {
  return db.runTransaction(async () => {
    const logId = o.nonce ? 'use_' + o.nonce : ''
    if (logId) {
      const done = await findOne('cw_card_logs', { _id: logId })
      if (done) return { remaining: done.remaining, duplicate: true }
    }
    const card = await findOne('cw_cards', { _id: String(o.cardId || '') })
    if (!card || (o.openid && card._openid !== o.openid)) throw new BizError('找不到这张次卡', 'CARD_GONE')
    const state = cardState(card)
    if (state === 'expired') throw new BizError('这张次卡 ' + card.expiresDay + ' 已经过期了', 'CARD_EXPIRED')
    if (state === 'used_up') throw new BizError('这张次卡次数用完了', 'CARD_EMPTY')
    if (state !== 'active') throw new BizError('这张次卡已经退了', 'CARD_GONE')
    if (o.serviceId && (card.serviceIds || []).indexOf(o.serviceId) === -1) throw new BizError('这张次卡不能用在这个项目上', 'CARD_NOT_FOR_SERVICE')
    const res = await col('cw_cards').where({ _id: card._id, status: 'active', remaining: _.gte(1) })
      .update({ data: { remaining: _.inc(-1), updatedAt: new Date() } })
    if (!res.stats.updated) throw new BizError('这张次卡次数用完了', 'CARD_EMPTY')
    const remaining = card.remaining - 1
    const entry = { type: 'use', change: -1, remaining, title: o.title || '用了一次', refType: o.refType || '', refId: o.refId || '', refNo: o.refNo || '', operator: o.operator || '', operatorName: o.operatorName || '' }
    if (logId) entry._id = logId
    await addCardLog(card, entry)
    return { remaining, duplicate: false, card }
  })
}

// 退回一次（预约取消）；guard 在同一个队列里先跑，返回 false 就不退（同一单只退一次）
function returnCard({ cardId, title, refType, refId, refNo, guard }) {
  return db.runTransaction(async () => {
    if (guard && !(await guard())) return false
    const card = await findOne('cw_cards', { _id: String(cardId || '') })
    if (!card || card.status !== 'active') return false
    await col('cw_cards').doc(card._id).update({ data: { remaining: _.inc(1), updatedAt: new Date() } })
    await addCardLog(card, { type: 'return', change: 1, remaining: card.remaining + 1, title, refType, refId, refNo })
    return true
  })
}

// 顾客能用在这个项目上的卡（没过期、有次数）
async function usableCards(openid, serviceId) {
  const list = await safeList(col('cw_cards').where({ _openid: openid, status: 'active' }).orderBy('createdAt', 'asc').limit(100))
  const today = cnDay()
  return list.filter((c) => cardState(c, today) === 'active' && (!serviceId || (c.serviceIds || []).indexOf(serviceId) !== -1))
}

function cleanCardType(t, serviceIds) {
  const price = Number(t.price)
  if (!Number.isInteger(price) || price <= 0 || price > MAX_CARD_PRICE) throw new BizError('次卡价格请填 0.01 到 ' + yuan(MAX_CARD_PRICE) + ' 元')
  const times = Number(t.times)
  if (!Number.isInteger(times) || times < 1 || times > MAX_CARD_TIMES) throw new BizError('次数请填 1 到 ' + MAX_CARD_TIMES)
  const validDays = t.validDays === undefined || t.validDays === '' || t.validDays === null ? NaN : Number(t.validDays)
  if (!Number.isInteger(validDays) || validDays < 0 || validDays > MAX_CARD_DAYS) throw new BizError('有效天数请填 0 到 ' + MAX_CARD_DAYS + '，不限期填 0')
  const ids = []
  ;(Array.isArray(t.serviceIds) ? t.serviceIds : []).forEach((id) => {
    if (serviceIds.indexOf(id) !== -1 && ids.indexOf(id) === -1) ids.push(id)
  })
  if (!ids.length) throw new BizError('请选这张卡能用在哪些项目上')
  const name = cleanText(t.name, 20)
  if (!name) throw new BizError('请填次卡名称，比如「精洗 10 次卡」')
  return { name, price, times, validDays, serviceIds: ids, desc: cleanText(t.desc, 60), enabled: t.enabled !== false }
}

function publicCardType(t) {
  return {
    _id: t._id,
    name: t.name,
    price: t.price,
    times: t.times,
    validDays: t.validDays || 0,
    serviceIds: t.serviceIds || [],
    desc: t.desc || ''
  }
}

async function enabledCardTypes() {
  const list = await safeList(col('cw_card_types').where({ enabled: true }).orderBy('sort', 'asc').limit(MAX_CARD_TYPES))
  const names = {}
  const services = await safeList(col('cw_services').limit(200))
  services.forEach((s) => { names[s._id] = s.name })
  return list.map((t) => Object.assign(publicCardType(t), { serviceNames: (t.serviceIds || []).map((id) => names[id]).filter(Boolean) }))
}

async function usableCardType(id) {
  const type = await findOne('cw_card_types', { _id: String(id || '') })
  if (!type || !type.enabled) throw new BizError('这种次卡已经下架了，请重新选择', 'CARD_TYPE_GONE')
  return type
}

// ---------- 在线付款（洗车商户号） ----------

async function markRechargePaid(recharge, paid) {
  if (!paid || paid.totalFee !== recharge.price) {
    if (paid) console.error('carwash recharge amount mismatch', recharge.rechargeNo, paid.totalFee, recharge.price)
    return false
  }
  await ledger.change(db, recharge._openid, recharge.price + recharge.bonus, {
    type: 'recharge',
    title: recharge.title,
    refType: 'recharge',
    refId: recharge._id,
    refNo: recharge.rechargeNo
  }, {
    principal: recharge.price,
    bonus: recharge.bonus,
    memberDays: recharge.memberDays,
    guard: async () => {
      const res = await col('cw_recharges')
        .where({ _id: recharge._id, payStatus: 'unpaid' })
        .update({ data: { payStatus: 'paid', transactionId: paid.transactionId, paidAt: new Date(), updatedAt: new Date() } })
      return res.stats.updated > 0
    }
  })
  await link.issue(db, { trigger: 'recharge', openid: recharge._openid, refNo: recharge.rechargeNo, amount: recharge.price })
  return true
}

// 先开卡（同一个单号只开一张），再把单子标成已付
async function markCardPaid(order, paid) {
  if (!paid || paid.totalFee !== order.price) {
    if (paid) console.error('carwash card amount mismatch', order.buyNo, paid.totalFee, order.price)
    return false
  }
  const card = await issueCard({ openid: order._openid, memberNo: order.memberNo, type: order.type, source: 'wechat', refNo: order.buyNo })
  await col('cw_card_orders').where({ _id: order._id, payStatus: 'unpaid' })
    .update({ data: { payStatus: 'paid', cardId: card._id, transactionId: paid.transactionId, paidAt: new Date(), updatedAt: new Date() } })
  return true
}

// 微信支付通知：CC 开头是充值，CK 开头是办卡
async function onPayNotify({ outTradeNo }) {
  if (typeof outTradeNo !== 'string') return false
  if (outTradeNo.indexOf('CC') === 0) {
    const recharge = await findOne('cw_recharges', { rechargeNo: outTradeNo })
    if (!recharge) return true
    if (recharge.payStatus === 'unpaid') await markRechargePaid(recharge, await pay.queryPaid(outTradeNo, SHOP))
    // 已经到账的再补一次送券（发过的不会重复发）
    else await link.issue(db, { trigger: 'recharge', openid: recharge._openid, refNo: recharge.rechargeNo, amount: recharge.price })
    return true
  }
  if (outTradeNo.indexOf('CK') === 0) {
    const order = await findOne('cw_card_orders', { buyNo: outTradeNo })
    if (order && order.payStatus === 'unpaid') await markCardPaid(order, await pay.queryPaid(outTradeNo, SHOP))
    return true
  }
  return false
}

function adminMember(m) {
  return Object.assign(wallet.publicMember(m), { remark: m.remark || '', createdAt: m.createdAt, updatedAt: m.updatedAt })
}

const requireAdmin = (openid) => requireRole(db, openid, CARWASH_ROLES)
const requireStaff = (openid) => requireRole(db, openid, CARWASH_STAFF)

const handlers = {
  // ---------- 顾客端 ----------

  // 会员中心：第一次打开时开洗车的账（会员号和咖啡通用）
  async getMember(event, openid) {
    const [settings, member, planList, types, ways] = await Promise.all([
      readMemberSettings(),
      ledger.ensureMember(db, openid),
      plans.enabled(),
      enabledCardTypes(),
      payWays()
    ])
    const cards = await safeList(col('cw_cards').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(50))
    return {
      member: wallet.publicMember(member),
      settings,
      plans: settings.enabled ? planList.map(publicPlan) : [],
      cardTypes: types,
      cards: cards.map((c) => publicCard(c)),
      pay: { wechat: ways.wechat }
    }
  },

  async myMemberLogs({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const list = await safeList(col('cw_member_logs').where({ _openid: openid }).orderBy('createdAt', 'desc').skip(p * size).limit(size))
    return { logs: list.map((l) => wallet.publicLog(l)), hasMore: list.length === size }
  },

  async myCards(event, openid) {
    const cards = await safeList(col('cw_cards').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(50))
    return { cards: cards.map((c) => publicCard(c)) }
  },

  async myCardLogs({ cardId }, openid) {
    const card = await findOne('cw_cards', { _id: String(cardId || ''), _openid: openid })
    if (!card) throw new BizError('找不到这张次卡')
    const logs = await safeList(col('cw_card_logs').where({ cardId: card._id }).orderBy('createdAt', 'desc').limit(100))
    return { card: publicCard(card), logs: logs.map((l) => publicCardLog(l)) }
  },

  // 我的券：两个小程序看到的是同一批券，现在都只能在进山咖啡用
  async myVouchers(event, openid) {
    const today = cnDay()
    const list = (await safeList(col('vouchers').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(100))).map((v) => link.publicVoucher(v, today))
    return { usable: list.filter((v) => v.status === 'unused'), others: list.filter((v) => v.status !== 'unused') }
  },

  // 在线充值：返回充值单 id 和 wx.requestPayment 要的参数
  async createRecharge({ planId }, openid) {
    const settings = await readMemberSettings()
    if (!settings.enabled) throw new BizError('店里暂时没开放充值', 'MEMBER_DISABLED')
    const plan = await plans.usable(planId)
    const ways = await payWays()
    if (!ways.wechat) throw new BizError('店里还没开通微信支付，请到店里找店员充值', 'PAY_DISABLED')
    const member = await ledger.ensureMember(db, openid)
    const recharge = {
      _openid: openid,
      memberNo: member.memberNo,
      rechargeNo: makeNo('CC'),
      planId: plan._id,
      title: plan.title,
      price: plan.price,
      bonus: plan.bonus || 0,
      memberDays: plan.memberDays || 0,
      payStatus: 'unpaid',
      day: cnDay(),
      createdAt: new Date(),
      updatedAt: new Date()
    }
    const added = await col('cw_recharges').add({ data: recharge })
    const payment = await pay.unifiedOrder({ payEnabled: true }, {
      body: '洗车会员-' + plan.title,
      outTradeNo: recharge.rechargeNo,
      totalFee: recharge.price,
      openid,
      notify: 'carwash',
      shop: SHOP,
      timeExpire: Date.now() + PAY_MINUTES * 60000
    })
    return { id: added._id, payment }
  },

  async confirmRecharge({ id }, openid) {
    const recharge = await findOne('cw_recharges', { _id: String(id || ''), _openid: openid })
    if (!recharge) throw new BizError('充值记录不存在')
    if (recharge.payStatus === 'unpaid' && (await markRechargePaid(recharge, await pay.queryPaid(recharge.rechargeNo, SHOP)))) {
      return { payStatus: 'paid' }
    }
    return { payStatus: recharge.payStatus }
  },

  // 在线办次卡：payBy 是 wechat（返回支付参数）或 balance（直接扣余额开卡）
  async buyCard({ typeId, payBy }, openid) {
    const type = await usableCardType(typeId)
    const member = await ledger.ensureMember(db, openid)
    const ways = await payWays()
    const buyNo = makeNo('CK')
    if (payBy === 'balance') {
      if (!ways.member) throw new BizError('店里暂时没开放余额付款', 'MEMBER_DISABLED')
      await ledger.pay(db, openid, type.price, { title: '办卡 ' + type.name, refType: 'card', refNo: buyNo })
      try {
        const card = await issueCard({ openid, memberNo: member.memberNo, type, source: 'balance', refNo: buyNo })
        return { cardId: card._id, paid: true }
      } catch (e) {
        await ledger.refund(db, openid, type.price, { title: '办卡没成功退回', refType: 'card', refNo: buyNo })
        throw e
      }
    }
    if (payBy !== 'wechat') throw new BizError('请选择付款方式')
    if (!ways.wechat) throw new BizError('店里还没开通微信支付，请到店里找店员办卡', 'PAY_DISABLED')
    const order = {
      _openid: openid,
      memberNo: member.memberNo,
      buyNo,
      typeId: type._id,
      type: { _id: type._id, name: type.name, price: type.price, times: type.times, validDays: type.validDays || 0, serviceIds: type.serviceIds || [] },
      price: type.price,
      payStatus: 'unpaid',
      day: cnDay(),
      createdAt: new Date(),
      updatedAt: new Date()
    }
    const added = await col('cw_card_orders').add({ data: order })
    const payment = await pay.unifiedOrder({ payEnabled: true }, {
      body: '洗车次卡-' + type.name,
      outTradeNo: buyNo,
      totalFee: type.price,
      openid,
      notify: 'carwash',
      shop: SHOP,
      timeExpire: Date.now() + PAY_MINUTES * 60000
    })
    return { id: added._id, payment }
  },

  async confirmCardPay({ id }, openid) {
    const order = await findOne('cw_card_orders', { _id: String(id || ''), _openid: openid })
    if (!order) throw new BizError('办卡记录不存在')
    if (order.payStatus === 'unpaid' && (await markCardPaid(order, await pay.queryPaid(order.buyNo, SHOP)))) return { payStatus: 'paid' }
    return { payStatus: order.payStatus }
  },

  // ---------- 店员（店长、技师）：到店充值、办卡、用卡 ----------

  async staffFindMember({ memberNo }, openid) {
    await requireStaff(openid)
    const m = await memberByNo(memberNo)
    const [cards, planList, types] = await Promise.all([
      usableCards(m._id),
      plans.enabled(),
      enabledCardTypes()
    ])
    return { member: adminMember(m), cards: cards.map((c) => publicCard(c)), plans: planList.map(publicPlan), cardTypes: types }
  },

  // 到店充值：顾客当面付钱（现金、收款码）后，按档位给他充上
  async counterRecharge({ memberNo, planId }, openid) {
    const staff = await requireStaff(openid)
    const m = await memberByNo(memberNo)
    const plan = await plans.usable(planId)
    const refNo = makeNo('CT')
    const res = await ledger.change(db, m._id, plan.price + (plan.bonus || 0), {
      type: 'counter',
      title: plan.title,
      refType: 'plan',
      refId: plan._id,
      refNo,
      operator: openid,
      operatorName: staffName(staff)
    }, { principal: plan.price, bonus: plan.bonus || 0, memberDays: plan.memberDays || 0 })
    const vouchers = await link.issue(db, { trigger: 'recharge', openid: m._id, refNo, amount: plan.price })
    return { balance: res.balance, memberUntil: res.memberUntil, memberNo: m.memberNo, vouchers }
  },

  // 到店办卡：顾客当面付钱后开卡
  async counterSellCard({ memberNo, typeId }, openid) {
    const staff = await requireStaff(openid)
    const m = await memberByNo(memberNo)
    const type = await usableCardType(typeId)
    const card = await issueCard({ openid: m._id, memberNo: m.memberNo, type, source: 'counter', refNo: makeNo('CT'), operator: openid, operatorName: staffName(staff) })
    return { card: publicCard(card) }
  },

  // 到店直接用卡（没在小程序里预约的）：nonce 是页面生成的请求号，连点两下只扣一次
  async staffUseCard({ memberNo, cardId, serviceId, nonce, note }, openid) {
    const staff = await requireStaff(openid)
    if (nonce !== undefined && !NONCE_RE.test(String(nonce))) throw new BizError('请求号不对')
    const m = await memberByNo(memberNo)
    const res = await useCard({
      cardId,
      openid: m._id,
      serviceId: serviceId || '',
      nonce: nonce || '',
      title: '到店用卡' + (note ? ' ' + cleanText(note, 20) : ''),
      refType: 'walkin',
      operator: openid,
      operatorName: staffName(staff)
    })
    return { remaining: res.remaining, duplicate: res.duplicate }
  },

  // ---------- 后台：会员（店长） ----------

  async listMembers({ keyword, page }, openid) {
    await requireAdmin(openid)
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const kw = cleanText(keyword, 20)
    if (!kw) {
      const list = await safeList(col('cw_members').orderBy('updatedAt', 'desc').skip(p * size).limit(size))
      return { members: list.map(adminMember), hasMore: list.length === size }
    }
    if (wallet.MEMBER_NO_RE.test(kw)) {
      const list = await safeList(col('cw_members').where({ memberNo: kw }).limit(1))
      if (list.length) return { members: list.map(adminMember), hasMore: false }
    }
    let all = []
    try {
      all = await fetchAll(col('cw_members').orderBy('updatedAt', 'desc'), 5000)
    } catch (e) {
      if (!isMissingCollection(e)) throw e
    }
    const matched = all.filter((m) => (m.remark || '').indexOf(kw) !== -1 || m.memberNo.indexOf(kw) !== -1)
    return { members: matched.slice(p * size, (p + 1) * size).map(adminMember), hasMore: matched.length > (p + 1) * size }
  },

  async getMemberDetail({ memberNo }, openid) {
    await requireAdmin(openid)
    const m = await memberByNo(memberNo)
    const [logs, cards, cardLogs, vouchers, planList, types] = await Promise.all([
      safeList(col('cw_member_logs').where({ memberNo: m.memberNo }).orderBy('createdAt', 'desc').limit(50)),
      safeList(col('cw_cards').where({ memberNo: m.memberNo }).orderBy('createdAt', 'desc').limit(50)),
      safeList(col('cw_card_logs').where({ memberNo: m.memberNo }).orderBy('createdAt', 'desc').limit(50)),
      safeList(col('vouchers').where({ _openid: m._id, issuedBy: 'carwash' }).orderBy('createdAt', 'desc').limit(100)),
      plans.enabled(),
      enabledCardTypes()
    ])
    const today = cnDay()
    return {
      member: adminMember(m),
      logs: logs.map((l) => wallet.publicLog(l, true)),
      cards: cards.map((c) => publicCard(c, today)),
      cardLogs: cardLogs.map((l) => publicCardLog(l, true)),
      vouchers: vouchers.map((v) => Object.assign(link.publicVoucher(v, today), { refNo: v.refNo || '' })),
      plans: planList.map(publicPlan),
      cardTypes: types
    }
  },

  async setMemberRemark({ memberNo, remark }, openid) {
    await requireAdmin(openid)
    const m = await memberByNo(memberNo)
    await col('cw_members').doc(m._id).update({ data: { remark: cleanText(remark, 30) } })
    return true
  },

  // 店长手动调整余额或会员到期日：线下退款后扣掉余额、补偿等，必须写原因
  async adjustMember({ memberNo, amount, memberUntil, reason }, openid) {
    const staff = await requireAdmin(openid)
    const m = await memberByNo(memberNo)
    const fee = amount === undefined || amount === null || amount === '' ? 0 : Number(amount)
    if (!Number.isInteger(fee) || Math.abs(fee) > MAX_ADJUST) throw new BizError('调整金额不对，一次最多 ' + yuan(MAX_ADJUST) + ' 元')
    const opts = {}
    if (memberUntil !== undefined && memberUntil !== null && memberUntil !== (m.memberUntil || '')) {
      if (memberUntil !== '' && !DAY_RE.test(memberUntil)) throw new BizError('会员到期日格式不对')
      opts.memberUntil = memberUntil
    }
    if (!fee && opts.memberUntil === undefined) throw new BizError('金额和会员到期日都没有变')
    const why = cleanText(reason, 40)
    if (!why) throw new BizError('请写上调整原因，比如「线下退款」')
    let title = fee ? (fee > 0 ? '店长加余额' : '店长扣余额') : ''
    if (opts.memberUntil !== undefined) title += (title ? '，' : '') + (opts.memberUntil ? '会员改到 ' + opts.memberUntil : '取消会员')
    const res = await ledger.change(db, m._id, fee, { type: 'adjust', title, reason: why, operator: openid, operatorName: staffName(staff) }, opts)
    if (!res) throw new BizError('余额只有 ¥' + yuan(m.balance) + '，扣不了这么多', 'BALANCE_LOW')
    return { balance: res.balance, memberUntil: res.memberUntil }
  },

  // 调整次卡：加减次数（times 正数加、负数减）、改到期日（'' 表示不限期），要写原因
  async adjustCard({ cardId, times, expiresDay, reason }, openid) {
    const staff = await requireAdmin(openid)
    const why = cleanText(reason, 40)
    if (!why) throw new BizError('请写上调整原因')
    const delta = times === undefined || times === null || times === '' ? 0 : Number(times)
    if (!Number.isInteger(delta) || Math.abs(delta) > MAX_CARD_TIMES) throw new BizError('次数不对')
    if (expiresDay !== undefined && expiresDay !== null && expiresDay !== '' && !DAY_RE.test(expiresDay)) throw new BizError('到期日格式不对')
    return db.runTransaction(async () => {
      const card = await findOne('cw_cards', { _id: String(cardId || '') })
      if (!card || card.status !== 'active') throw new BizError('找不到这张次卡，或者已经退了')
      const data = { updatedAt: new Date() }
      if (delta) {
        if (card.remaining + delta < 0) throw new BizError('只剩 ' + card.remaining + ' 次，减不了这么多')
        data.remaining = _.inc(delta)
      }
      const changeDay = expiresDay !== undefined && expiresDay !== null && expiresDay !== (card.expiresDay || '')
      if (changeDay) data.expiresDay = expiresDay
      if (!delta && !changeDay) throw new BizError('次数和到期日都没有变')
      await col('cw_cards').doc(card._id).update({ data })
      const title = [delta ? (delta > 0 ? '加 ' + delta + ' 次' : '减 ' + -delta + ' 次') : '', changeDay ? (expiresDay ? '到期日改到 ' + expiresDay : '改成不限期') : ''].filter(Boolean).join('，')
      await addCardLog(card, { type: 'adjust', change: delta, remaining: card.remaining + delta, title, reason: why, operator: openid, operatorName: staffName(staff) })
      return { remaining: card.remaining + delta, expiresDay: changeDay ? expiresDay : card.expiresDay || '' }
    })
  },

  // 退卡：店长线下把钱退给顾客后在这里登记（退多少按店里的退费须知算），剩余次数清零；
  // revokeVouchers 为 true 时，办这张卡送的咖啡券里还没用的一起撤回
  async refundCard({ cardId, refundFee, reason, revokeVouchers }, openid) {
    const staff = await requireAdmin(openid)
    const why = cleanText(reason, 40)
    if (!why) throw new BizError('请写上退卡原因')
    const fee = Number(refundFee)
    if (!Number.isInteger(fee) || fee < 0 || fee > MAX_CARD_PRICE) throw new BizError('退了多少钱请填清楚，没退钱填 0')
    const card = await db.runTransaction(async () => {
      const c = await findOne('cw_cards', { _id: String(cardId || '') })
      if (!c || c.status !== 'active') throw new BizError('找不到这张次卡，或者已经退了')
      if (fee > c.price) throw new BizError('退的钱不能比办卡的钱（¥' + yuan(c.price) + '）多')
      await col('cw_cards').doc(c._id).update({ data: { status: 'refunded', remaining: 0, refundFee: fee, refundReason: why, refundedAt: new Date(), updatedAt: new Date() } })
      await addCardLog(c, { type: 'refund', change: -c.remaining, remaining: 0, title: '退卡，退回 ¥' + yuan(fee), reason: why, operator: openid, operatorName: staffName(staff) })
      return c
    })
    let revoked = 0
    if (revokeVouchers) {
      const list = await safeList(col('vouchers').where({ _openid: card._openid, issuedBy: 'carwash', refNo: card.refNo, status: 'unused' }).limit(100))
      for (const v of list) {
        await link.revoke(db, v._id, '退卡', openid)
        revoked++
      }
    }
    return { revoked }
  },

  async revokeVoucher({ id, reason }, openid) {
    await requireAdmin(openid)
    const why = cleanText(reason, 40)
    if (!why) throw new BizError('请写上撤回原因')
    return link.revoke(db, id, why, openid)
  },

  // 店长看账：每天充了多少（本金、赠送）、余额花了多少、卖了多少次卡、用了多少次
  async memberSummary({ from, to }, openid) {
    await requireAdmin(openid)
    const days = dayRange(from, to)
    let logs = []
    let cardLogs = []
    let cards = []
    let members = []
    try {
      ;[logs, cardLogs, cards, members] = await Promise.all([
        fetchAll(col('cw_member_logs').where({ day: _.in(days) })),
        fetchAll(col('cw_card_logs').where({ day: _.in(days) })),
        fetchAll(col('cw_cards').field({ price: true, source: true, createdAt: true, status: true, remaining: true, expiresDay: true })),
        fetchAll(col('cw_members').field({ balance: true, memberUntil: true }))
      ])
    } catch (e) {
      if (!isMissingCollection(e)) throw e
    }
    const rows = {}
    days.forEach((d) => {
      rows[d] = { day: d, recharges: 0, onlineFee: 0, counterFee: 0, bonusFee: 0, spentFee: 0, refundFee: 0, adjustFee: 0, cardsSold: 0, cardFee: 0, cardOnlineFee: 0, cardCounterFee: 0, cardUses: 0 }
    })
    logs.forEach((l) => {
      const r = rows[l.day]
      if (!r) return
      if (l.type === 'recharge' || l.type === 'counter') {
        r.recharges++
        if (l.type === 'recharge') r.onlineFee += l.principal
        else r.counterFee += l.principal
        r.bonusFee += l.bonus
      } else if (l.type === 'pay') r.spentFee -= l.amount
      else if (l.type === 'refund') r.refundFee += l.amount
      else if (l.type === 'adjust') r.adjustFee += l.amount
    })
    cardLogs.forEach((l) => {
      const r = rows[l.day]
      if (!r) return
      if (l.type === 'use') r.cardUses++
      if (l.type === 'return') r.cardUses--
    })
    cards.forEach((c) => {
      const r = rows[cnDay(new Date(c.createdAt).getTime())]
      if (!r) return
      r.cardsSold++
      // 用余额办的卡，钱已经算在充值里了，这里不重复算
      if (c.source !== 'balance') r.cardFee += c.price
      if (c.source === 'wechat') r.cardOnlineFee += c.price
      if (c.source === 'counter') r.cardCounterFee += c.price
    })
    const list = days.map((d) => rows[d])
    const totals = list.reduce((acc, r) => {
      Object.keys(r).forEach((k) => { if (k !== 'day') acc[k] = (acc[k] || 0) + r[k] })
      return acc
    }, {})
    const today = cnDay()
    return {
      days: list,
      totals,
      balanceTotal: members.reduce((s, m) => s + (m.balance || 0), 0),
      memberCount: members.filter((m) => wallet.isMember(m, today)).length,
      cardsLeft: cards.filter((c) => cardState(c, today) === 'active').reduce((s, c) => s + c.remaining, 0)
    }
  },

  // ---------- 后台：储值设置、充值档位、次卡种类（店长） ----------

  async getMemberSettings(event, openid) {
    await requireAdmin(openid)
    const [settings, planList, types, services, ways] = await Promise.all([
      readMemberSettings(),
      plans.list(),
      safeList(col('cw_card_types').orderBy('sort', 'asc').limit(MAX_CARD_TYPES)),
      safeList(col('cw_services').orderBy('sort', 'asc').limit(200)),
      payWays()
    ])
    return {
      settings,
      plans: planList,
      cardTypes: types,
      services: services.map((s) => ({ _id: s._id, name: s.name })),
      payEnabled: ways.wechat
    }
  },

  async saveMemberSettings({ enabled, notice, refundNotice }, openid) {
    await requireAdmin(openid)
    await col('settings').doc(MEMBER_SETTINGS_ID).set({
      data: { enabled: !!enabled, notice: cleanText(notice, 200), refundNotice: cleanText(refundNotice, 300), updatedBy: openid, updatedAt: db.serverDate() }
    })
    return readMemberSettings()
  },

  async savePlan({ plan }, openid) {
    await requireAdmin(openid)
    return plans.save(plan)
  },

  async setPlanFlags({ id, enabled }, openid) {
    await requireAdmin(openid)
    return plans.setEnabled(id, enabled)
  },

  async sortPlans({ ids }, openid) {
    await requireAdmin(openid)
    return plans.sort(ids)
  },

  async deletePlan({ id }, openid) {
    await requireAdmin(openid)
    return plans.remove(id)
  },

  async saveCardType({ cardType }, openid) {
    await requireAdmin(openid)
    const t = cardType || {}
    const services = await safeList(col('cw_services').limit(200))
    const data = cleanCardType(t, services.map((s) => s._id))
    data.updatedAt = db.serverDate()
    if (t._id) {
      const res = await col('cw_card_types').where({ _id: String(t._id) }).update({ data })
      if (!res.stats.updated) throw new BizError('这种次卡不存在了')
      return { id: String(t._id) }
    }
    const count = (await col('cw_card_types').count()).total
    if (count >= MAX_CARD_TYPES) throw new BizError('次卡种类最多 ' + MAX_CARD_TYPES + ' 种')
    data.sort = count
    data.createdAt = db.serverDate()
    const added = await col('cw_card_types').add({ data })
    return { id: added._id }
  },

  async setCardTypeFlags({ id, enabled }, openid) {
    await requireAdmin(openid)
    if (typeof enabled !== 'boolean') throw new BizError('参数不对')
    const res = await col('cw_card_types').where({ _id: String(id || '') }).update({ data: { enabled, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('这种次卡不存在了')
    return true
  },

  async sortCardTypes({ ids }, openid) {
    await requireAdmin(openid)
    if (!Array.isArray(ids) || ids.length > MAX_CARD_TYPES) throw new BizError('排序数据不对')
    await Promise.all(ids.map((id, index) => col('cw_card_types').where({ _id: String(id) }).update({ data: { sort: index } })))
    return true
  },

  // 删掉种类不影响顾客已经办了的卡
  async deleteCardType({ id }, openid) {
    await requireAdmin(openid)
    await col('cw_card_types').where({ _id: String(id || '') }).remove()
    return true
  }
}

module.exports = {
  ledger,
  handlers,
  onPayNotify,
  payWays,
  readMemberSettings,
  useCard,
  returnCard,
  usableCards,
  publicCard,
  cardState
}
