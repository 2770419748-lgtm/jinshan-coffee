// 会员储值的账本：余额、会员到期日、每一笔变动的流水。咖啡、书籍、会员三个模块都通过这里改余额。
// members 一人一条（_id 是 openid）；member_logs 是流水；settings 里 _id 为 member 的那条是会员设置。
// 改余额都走 change()：排队执行，余额不会扣成负数，流水里记的变动后余额也准。
const { BizError, isMissingCollection, cleanText, cnDay, nextSeq } = require('./base')

const DAY_MS = 24 * 3600 * 1000
// 会员号从 10001 开始
const MEMBER_NO_BASE = 10000
const MEMBER_NO_RE = /^\d{5,8}$/
const DEFAULT_SETTINGS = {
  enabled: false,
  freeCategories: ['漫画'],
  notice: '储值金额（含赠送）只能在店里点单、借书时使用，不能提现。'
}
const LOG_TYPES = {
  recharge: '在线充值',
  counter: '吧台充值',
  pay: '消费',
  refund: '退回',
  adjust: '店主调整'
}

async function safeFind(db, name, id) {
  try {
    const res = await db.collection(name).where({ _id: id }).limit(1).get()
    return res.data[0] || null
  } catch (e) {
    if (isMissingCollection(e)) return null
    throw e
  }
}

async function readSettings(db) {
  const s = (await safeFind(db, 'settings', 'member')) || {}
  return {
    enabled: !!s.enabled,
    freeCategories: Array.isArray(s.freeCategories) ? s.freeCategories : DEFAULT_SETTINGS.freeCategories.slice(),
    notice: typeof s.notice === 'string' ? s.notice : DEFAULT_SETTINGS.notice
  }
}

function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10)
}

// 会员到期日当天还算会员
function isMember(m, today) {
  return !!(m && m.memberUntil && m.memberUntil >= (today || cnDay()))
}

// 再充一次会员：还在会员期就从到期日往后加，不是会员就从今天算第 1 天
function extendUntil(m, days, today) {
  const t = today || cnDay()
  const base = isMember(m, t) ? m.memberUntil : addDays(t, -1)
  return addDays(base, days)
}

function findMember(db, openid) {
  return openid ? safeFind(db, 'members', openid) : Promise.resolve(null)
}

async function findByNo(db, memberNo) {
  const no = String(memberNo || '').trim()
  if (!MEMBER_NO_RE.test(no)) throw new BizError('会员号是 5 位以上的数字', 'MEMBER_NOT_FOUND')
  const res = await db.collection('members').where({ memberNo: no }).limit(1).get()
  if (!res.data[0]) throw new BizError('没有找到会员号 ' + no + '，请让顾客打开小程序「我的 → 会员中心」看一下', 'MEMBER_NOT_FOUND')
  return res.data[0]
}

// 第一次打开会员中心时发会员号；不能在 runTransaction 里调用（发号本身要排队）
async function ensureMember(db, openid) {
  if (!openid) throw new BizError('请在微信里打开小程序', 'NEED_LOGIN')
  const found = await findMember(db, openid)
  if (found) return found
  const seq = await nextSeq(db, 'member-no')
  const member = {
    memberNo: String(MEMBER_NO_BASE + seq),
    balance: 0,
    memberUntil: '',
    totalRecharge: 0, // 充进来的本金
    totalBonus: 0, // 送的金额
    totalSpent: 0,
    remark: '',
    createdAt: new Date(),
    updatedAt: new Date()
  }
  try {
    await db.collection('members').add({ data: Object.assign({ _id: openid }, member) })
  } catch (e) {
    // 同一个人同时点了两次，另一次已经建好了
    const again = await findMember(db, openid)
    if (again) return again
    throw e
  }
  return Object.assign({ _id: openid }, member)
}

// 改余额。amount 正数是加、负数是扣；扣的时候余额不够返回 null。
// log：流水里的 type、title、refType、refId、refNo、operator、operatorName、reason 等
// opts.memberDays：顺便加几天会员；opts.memberUntil：直接改到期日（'' 表示取消会员）
// opts.principal / opts.bonus：充值时本金和赠送各多少；opts.guard：在同一个队列里先跑，返回 false 就什么都不做
async function change(db, openid, amount, log, opts) {
  const o = opts || {}
  const _ = db.command
  return db.runTransaction(async () => {
    if (o.guard && !(await o.guard())) return false
    const m = await findMember(db, openid)
    if (!m) throw new BizError('还没有会员号，请先打开「我的 → 会员中心」', 'MEMBER_NOT_FOUND')
    if (amount < 0 && m.balance < -amount) return null
    const today = cnDay()
    const data = { balance: _.inc(amount), updatedAt: new Date() }
    let memberUntil = m.memberUntil || ''
    if (o.memberDays) memberUntil = extendUntil(m, o.memberDays, today)
    if (o.memberUntil !== undefined) memberUntil = o.memberUntil
    if (memberUntil !== (m.memberUntil || '')) data.memberUntil = memberUntil
    if (o.principal) data.totalRecharge = _.inc(o.principal)
    if (o.bonus) data.totalBonus = _.inc(o.bonus)
    if (log.type === 'pay') data.totalSpent = _.inc(-amount)
    if (log.type === 'refund') data.totalSpent = _.inc(-amount)
    const where = amount < 0 ? { _id: openid, balance: _.gte(-amount) } : { _id: openid }
    const res = await db.collection('members').where(where).update({ data })
    if (!res.stats.updated) return null
    const balance = m.balance + amount
    const entry = {
      _openid: openid,
      memberNo: m.memberNo,
      type: log.type,
      title: cleanText(log.title, 40),
      amount,
      balance,
      principal: o.principal || 0,
      bonus: o.bonus || 0,
      memberDays: o.memberDays || 0,
      memberUntil: data.memberUntil !== undefined ? data.memberUntil : null,
      refType: log.refType || '',
      refId: log.refId || '',
      refNo: log.refNo || '',
      operator: log.operator || '',
      operatorName: log.operatorName || '',
      reason: cleanText(log.reason, 40),
      day: today,
      createdAt: new Date()
    }
    await db.collection('member_logs').add({ data: entry })
    return { balance, memberUntil, memberNo: m.memberNo }
  })
}

// 扣余额付款；余额不够直接报错
async function pay(db, openid, amount, log) {
  const res = await change(db, openid, -amount, Object.assign({ type: 'pay' }, log))
  if (!res) throw new BizError('余额不够了，换个付款方式，或者先充值', 'BALANCE_LOW')
  return res
}

// 订单取消、扣了钱却没下成单时退回余额；guard 见 change()
function refund(db, openid, amount, log, guard) {
  return change(db, openid, amount, Object.assign({ type: 'refund' }, log), { guard })
}

function publicMember(m, today) {
  if (!m) return null
  return {
    memberNo: m.memberNo,
    balance: m.balance || 0,
    memberUntil: m.memberUntil || '',
    isMember: isMember(m, today),
    totalRecharge: m.totalRecharge || 0,
    totalBonus: m.totalBonus || 0,
    totalSpent: m.totalSpent || 0
  }
}

// 顾客看的流水：不带操作人
function publicLog(l, staffView) {
  const out = {
    _id: l._id,
    type: l.type,
    typeName: LOG_TYPES[l.type] || l.type,
    title: l.title,
    amount: l.amount,
    balance: l.balance,
    bonus: l.bonus || 0,
    memberDays: l.memberDays || 0,
    memberUntil: l.memberUntil,
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

// 结算页、借书页要的余额信息：会员功能开没开、余额多少（没会员号就是 0）
async function walletInfo(db, openid) {
  const [settings, m] = await Promise.all([readSettings(db), findMember(db, openid)])
  return {
    enabled: settings.enabled,
    balance: m ? m.balance || 0 : 0,
    memberNo: m ? m.memberNo : '',
    isMember: isMember(m),
    memberUntil: m ? m.memberUntil || '' : ''
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  LOG_TYPES,
  MEMBER_NO_RE,
  readSettings,
  addDays,
  isMember,
  extendUntil,
  findMember,
  findByNo,
  ensureMember,
  change,
  pay,
  refund,
  publicMember,
  publicLog,
  walletInfo
}
