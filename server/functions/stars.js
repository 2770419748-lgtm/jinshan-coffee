// 集星：顾客在小程序里买一杯得一颗星，出餐后到账；攒够了点单时免费换一杯。规则是 settings 里 _id 为 stars 的那条，店主在后台配。
// 星星记在 members 上（和会员号同一条）：stars 是现在有几颗，starLots 按得到的日子分批记 [{ day, n }]（从早到晚），
// 设了有效期时按批过期，兑换时先用最早的；star_logs 是每一笔变动。
// 改星星都走 change()：排队执行，不会扣成负数，流水里记的变动后颗数也准。
const { BizError, isMissingCollection, cleanText, cnDay } = require('./base')
const wallet = require('./wallet')

const DEFAULT_SETTINGS = {
  enabled: false,
  need: 10, // 几颗星换一杯
  earnAll: true, // 买什么都得星；false 时只有 earnCategories 里的分类（分类 _id）得星
  earnCategories: [],
  redeemAll: true, // 什么都能换；false 时只能换 redeemCategories 里的分类
  redeemCategories: [],
  maxFee: 0, // 换的那杯最多抵多少（分），0 表示整杯免费
  validDays: 0 // 每颗星从得到那天起几天有效（当天算第 1 天），0 表示一直有效
}
const MAX_NEED = 100
const MAX_VALID_DAYS = 3650
const MAX_FEE = 100000
// 一个人最多记这么多批，再多就把最早的两批并到一起（往晚的算，对顾客有利）
const MAX_LOTS = 400
const LOG_TYPES = {
  earn: '消费得星',
  redeem: '兑换',
  refund: '退回',
  expire: '过期',
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

function idList(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : []
}

async function readSettings(db) {
  const s = (await safeFind(db, 'settings', 'stars')) || {}
  const num = (v, fallback) => (Number.isInteger(v) ? v : fallback)
  return {
    enabled: !!s.enabled,
    need: num(s.need, DEFAULT_SETTINGS.need),
    earnAll: s.earnAll !== false,
    earnCategories: idList(s.earnCategories),
    redeemAll: s.redeemAll !== false,
    redeemCategories: idList(s.redeemCategories),
    maxFee: num(s.maxFee, DEFAULT_SETTINGS.maxFee),
    validDays: num(s.validDays, DEFAULT_SETTINGS.validDays)
  }
}

// 店主保存设置时检查；不合规的直接报错。categoryIds 是现在还有的咖啡分类，删掉的分类不留
function cleanSettings(input, categoryIds) {
  const s = input || {}
  const need = Number(s.need)
  if (!Number.isInteger(need) || need < 1 || need > MAX_NEED) throw new BizError('几颗星换一杯请填 1 到 ' + MAX_NEED)
  const maxFee = s.maxFee === undefined || s.maxFee === null || s.maxFee === '' ? 0 : Number(s.maxFee)
  if (!Number.isInteger(maxFee) || maxFee < 0 || maxFee > MAX_FEE) throw new BizError('每杯最多抵多少不对，整杯免费填 0')
  const validDays = s.validDays === undefined || s.validDays === null || s.validDays === '' ? 0 : Number(s.validDays)
  if (!Number.isInteger(validDays) || validDays < 0 || validDays > MAX_VALID_DAYS) throw new BizError('有效天数请填 0 到 ' + MAX_VALID_DAYS + '，一直有效填 0')
  const cats = (v) => {
    const list = []
    idList(v).forEach((id) => { if (categoryIds.indexOf(id) !== -1 && list.indexOf(id) === -1) list.push(id) })
    return list
  }
  const out = {
    enabled: !!s.enabled,
    need,
    earnAll: s.earnAll !== false,
    earnCategories: cats(s.earnCategories),
    redeemAll: s.redeemAll !== false,
    redeemCategories: cats(s.redeemCategories),
    maxFee,
    validDays
  }
  if (!out.earnAll && !out.earnCategories.length) throw new BizError('请选择买哪些分类的商品得星')
  if (!out.redeemAll && !out.redeemCategories.length) throw new BizError('请选择能换哪些分类的商品')
  return out
}

// 这一批星星最后有效的那天；一直有效返回 ''
function lotLastDay(day, validDays) {
  return validDays ? wallet.addDays(day, validDays - 1) : ''
}

// 把批次分成过期的和还能用的
function splitLots(lots, validDays, today) {
  const live = []
  let expired = 0
  ;(lots || []).forEach((l) => {
    if (validDays && lotLastDay(l.day, validDays) < today) expired += l.n
    else live.push({ day: l.day, n: l.n })
  })
  return { live, expired }
}

function sumLots(lots) {
  return lots.reduce((s, l) => s + l.n, 0)
}

// 加回几批（同一天的并在一起，按日子排好）
function addLots(lots, add) {
  const byDay = {}
  lots.concat(add).forEach((l) => {
    if (l.n > 0) byDay[l.day] = (byDay[l.day] || 0) + l.n
  })
  const out = Object.keys(byDay).sort().map((day) => ({ day, n: byDay[day] }))
  while (out.length > MAX_LOTS) {
    out[1].n += out[0].n
    out.shift()
  }
  return out
}

// 从最早的批次开始扣，返回剩下的和扣掉的
function takeLots(lots, count) {
  const left = []
  const taken = []
  let need = count
  lots.forEach((l) => {
    const n = Math.min(l.n, need)
    if (n) taken.push({ day: l.day, n })
    need -= n
    if (l.n > n) left.push({ day: l.day, n: l.n - n })
  })
  return { left, taken }
}

function addLog(db, m, entry) {
  return db.collection('star_logs').add({
    data: Object.assign({
      _openid: m._id,
      memberNo: m.memberNo,
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
  })
}

// 改星星。amount 正数是加、负数是扣、0 只处理过期；扣的时候不够返回 null。
// log：流水里的 type、title、refType、refId、refNo、operator、operatorName、reason
// opts.lots：加回指定的批次（兑换的单取消时按原来的日子退回）；opts.guard：在同一个队列里先跑，返回 false 就什么都不做
// 返回 { stars, taken（扣掉的批次）, memberNo }
async function change(db, openid, amount, log, opts) {
  const o = opts || {}
  const _ = db.command
  return db.runTransaction(async () => {
    const m = await wallet.findMember(db, openid)
    if (!m) {
      if (amount > 0) throw new BizError('还没有会员号', 'MEMBER_NOT_FOUND')
      return amount < 0 ? null : { stars: 0, taken: [], memberNo: '' }
    }
    const settings = await readSettings(db)
    const today = cnDay()
    const { live, expired } = splitLots(m.starLots, settings.validDays, today)
    let lots = live
    let stars = sumLots(lots)
    const data = {}
    if (expired) {
      await addLog(db, m, { type: 'expire', title: '星星过期', amount: -expired, stars })
    }
    let taken = []
    let ok = true
    if (amount < 0 && stars < -amount) ok = false
    if (ok && o.guard && !(await o.guard())) ok = false
    if (ok && amount > 0) {
      lots = addLots(lots, o.lots && sumLots(o.lots) === amount ? o.lots : [{ day: today, n: amount }])
    } else if (ok && amount < 0) {
      const res = takeLots(lots, -amount)
      lots = res.left
      taken = res.taken
    }
    if (ok && amount) {
      stars += amount
      // 累计得到的：消费得的加上店主补的
      if (log.type === 'earn' || (log.type === 'adjust' && amount > 0)) data.starsEarned = _.inc(amount)
      if (log.type === 'redeem') data.starsUsed = _.inc(-amount)
      if (log.type === 'refund') data.starsUsed = _.inc(-amount)
      await addLog(db, m, {
        type: log.type,
        title: cleanText(log.title, 40),
        amount,
        stars,
        refType: log.refType || '',
        refId: log.refId || '',
        refNo: log.refNo || '',
        operator: log.operator || '',
        operatorName: log.operatorName || '',
        reason: cleanText(log.reason, 40)
      })
    }
    if (expired || (ok && amount)) {
      data.stars = stars
      data.starLots = _.set(lots)
      // 最早一批的日子，定时清过期时按它找人；没有星星时是 null，不会被找到
      data.starsFrom = lots.length ? lots[0].day : null
      data.starsUpdatedAt = new Date()
      await db.collection('members').doc(m._id).update({ data })
    }
    if (!ok) return null
    return { stars, taken, memberNo: m.memberNo }
  })
}

// 出餐后给星：同一单只给一次（guard 里把订单标成已给）
async function credit(db, order, guard) {
  await wallet.ensureMember(db, order._openid)
  return change(db, order._openid, order.starsEarn, {
    type: 'earn',
    title: '取餐号 ' + order.pickupNo + ' 得星',
    refType: 'coffee',
    refId: order._id,
    refNo: order.orderNo
  }, { guard })
}

// 点单兑换：扣星，不够报错
async function redeem(db, openid, count, log) {
  const res = await change(db, openid, -count, Object.assign({ type: 'redeem' }, log))
  if (!res) throw new BizError('星星不够了，请重新确认订单', 'STARS_CHANGED')
  return res
}

// 兑换的单取消、没下成单时退回；lots 是当时扣掉的批次
function giveBack(db, openid, count, lots, log, guard) {
  return change(db, openid, count, Object.assign({ type: 'refund' }, log), { lots, guard })
}

// 设了有效期时，把过期的星星清掉（服务器定时跑）；没设有效期什么都不做
async function expireAll(db) {
  const settings = await readSettings(db)
  if (!settings.validDays) return 0
  // 这天以前得的星星都过期了
  const firstLive = wallet.addDays(cnDay(), -(settings.validDays - 1))
  let list = []
  try {
    list = (await db.collection('members').where({ starsFrom: db.command.lt(firstLive) }).field({ _id: true }).limit(500).get()).data
  } catch (e) {
    if (!isMissingCollection(e)) throw e
  }
  for (const m of list) await change(db, m._id, 0, {})
  return list.length
}

// 顾客现在能用几颗（过期的不算，还没清掉的也不算），最早哪批、什么时候过期
function liveStars(m, settings, today) {
  const t = today || cnDay()
  const { live } = splitLots(m && m.starLots, settings.validDays, t)
  const stars = sumLots(live)
  let expiring = null
  if (settings.validDays && live.length) expiring = { n: live[0].n, day: lotLastDay(live[0].day, settings.validDays) }
  return { stars, expiring }
}

function publicLog(l, staffView) {
  const out = {
    _id: l._id,
    type: l.type,
    typeName: LOG_TYPES[l.type] || l.type,
    title: l.title,
    amount: l.amount,
    stars: l.stars,
    reason: l.reason || '',
    createdAt: l.createdAt
  }
  if (staffView) {
    out.operatorName = l.operatorName || ''
    out.refNo = l.refNo || ''
  }
  return out
}

// 这个分类的商品买了得不得星、能不能用星换
function earns(settings, categoryId) {
  return settings.earnAll || settings.earnCategories.indexOf(categoryId) !== -1
}

function redeemable(settings, categoryId) {
  return settings.redeemAll || settings.redeemCategories.indexOf(categoryId) !== -1
}

module.exports = {
  DEFAULT_SETTINGS,
  LOG_TYPES,
  MAX_NEED,
  MAX_VALID_DAYS,
  readSettings,
  cleanSettings,
  lotLastDay,
  splitLots,
  addLots,
  takeLots,
  change,
  credit,
  redeem,
  giveBack,
  expireAll,
  liveStars,
  publicLog,
  earns,
  redeemable
}
