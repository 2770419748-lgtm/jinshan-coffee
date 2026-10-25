// 洗车送咖啡券：店长在后台配规则（充值满多少、办哪种次卡，送几张、每张抵多少、门槛、有效几天），
// 条件满足时往 vouchers（和咖啡共用的券表）里写代金券。券上记着 issuedBy: 'carwash'、usableShops: ['coffee']：
// 咖啡下单时自动抵扣（coffee.js 的 usableCoupons 会认它），洗车这边不抵。
// 同一笔充值、同一张次卡只送一次：券的 _id 由规则和单号算出来，重复触发也不会多发。
const crypto = require('crypto')
const { BizError, isMissingCollection, cleanText, cnDay } = require('./base')
const { addDays } = require('./wallet')

const TRIGGERS = { recharge: '充值', card: '办次卡' }
const MAX_RULES = 30
const MAX_COUNT = 20
// 和咖啡的代金券一样：每张最多抵 200 元，最长一年
const MAX_AMOUNT = 20000
const MAX_DAYS = 365
const MAX_THRESHOLD = 1000000

function yuan(fen) {
  return (fen / 100).toFixed(2).replace(/\.?0+$/, '')
}

async function safeList(query) {
  try {
    return (await query.get()).data
  } catch (e) {
    if (isMissingCollection(e)) return []
    throw e
  }
}

function voucherTitle(rule) {
  return rule.title || ('洗车送 ¥' + yuan(rule.amount) + ' 咖啡券')
}

// 规则的说明，比如「充值满 300 元，送 2 张 ¥15 咖啡券（满 30 可用），30 天有效」
function ruleText(rule, cardName) {
  const when = rule.trigger === 'recharge'
    ? '充值满 ' + yuan(rule.minAmount) + ' 元'
    : '办「' + (cardName || '次卡') + '」'
  return when + '，送 ' + rule.count + ' 张 ¥' + yuan(rule.amount) + ' 咖啡券' +
    (rule.minSpend ? '（满 ' + yuan(rule.minSpend) + ' 可用）' : '（无门槛）') + '，' + rule.validDays + ' 天有效'
}

function intIn(value, min, max, msg) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new BizError(msg)
  return n
}

function cleanRule(r, cardTypeIds) {
  if (!TRIGGERS[r.trigger]) throw new BizError('请选择什么时候送')
  const data = {
    trigger: r.trigger,
    title: cleanText(r.title, 16),
    minAmount: 0,
    cardTypeId: '',
    count: intIn(r.count, 1, MAX_COUNT, '每次送几张请填 1 到 ' + MAX_COUNT),
    amount: intIn(r.amount, 1, MAX_AMOUNT, '每张抵多少请填 0.01 到 ' + yuan(MAX_AMOUNT) + ' 元'),
    minSpend: intIn(r.minSpend === undefined || r.minSpend === '' ? 0 : r.minSpend, 0, MAX_THRESHOLD, '使用门槛不对，无门槛填 0'),
    validDays: intIn(r.validDays, 1, MAX_DAYS, '有效天数请填 1 到 ' + MAX_DAYS),
    enabled: r.enabled !== false
  }
  if (r.trigger === 'recharge') {
    data.minAmount = intIn(r.minAmount, 1, MAX_THRESHOLD, '充值满多少请填 0.01 到 ' + yuan(MAX_THRESHOLD) + ' 元')
  } else {
    data.cardTypeId = String(r.cardTypeId || '')
    if (cardTypeIds.indexOf(data.cardTypeId) === -1) throw new BizError('请选择办哪种次卡时送')
  }
  return data
}

function voucherId(ruleId, refNo, i) {
  return 'cwv' + crypto.createHash('sha1').update(ruleId + ':' + refNo + ':' + i).digest('hex').slice(0, 24)
}

// 发券。event：{ trigger, openid, refNo, amount（充值本金，分）, cardTypeId }
// 充值按满足条件的最高一档送（充 500 不会同时拿「满 300」和「满 500」两档）；办次卡按这种卡的所有规则送。
// 返回发了几张
async function issue(db, event) {
  if (!event.openid || !event.refNo) return 0
  const rules = await safeList(db.collection('cw_link_rules').where({ trigger: event.trigger, enabled: true }).limit(MAX_RULES))
  let hit = []
  if (event.trigger === 'recharge') {
    const ok = rules.filter((r) => event.amount >= r.minAmount).sort((a, b) => b.minAmount - a.minAmount)
    hit = ok.slice(0, 1)
  } else if (event.trigger === 'card') {
    hit = rules.filter((r) => r.cardTypeId === event.cardTypeId)
  }
  const today = cnDay()
  let issued = 0
  for (const rule of hit) {
    for (let i = 0; i < rule.count; i++) {
      const voucher = {
        _id: voucherId(rule._id, event.refNo, i),
        _openid: event.openid,
        type: 'cash',
        couponId: 'cw:' + rule._id,
        title: voucherTitle(rule),
        amount: rule.amount,
        minSpend: rule.minSpend || 0,
        expiresDay: addDays(today, rule.validDays - 1),
        status: 'unused',
        issuedBy: 'carwash',
        usableShops: ['coffee'],
        ruleId: rule._id,
        refNo: event.refNo,
        createdAt: new Date()
      }
      try {
        await db.collection('vouchers').add({ data: voucher })
        issued++
      } catch (e) {
        // 这一张已经发过了（通知重复到达等）
        if (!/duplicate key/.test(String(e && e.message))) throw e
      }
    }
  }
  return issued
}

// 店长撤回一张还没用的券（比如顾客办卡后又退了）
async function revoke(db, id, reason, operator) {
  const res = await db.collection('vouchers')
    .where({ _id: String(id || ''), issuedBy: 'carwash', status: 'unused' })
    .update({ data: { status: 'revoked', revokedAt: new Date(), revokeReason: cleanText(reason, 40), revokedBy: operator } })
  if (!res.stats.updated) throw new BizError('这张券已经用掉或撤回了')
  return true
}

// 顾客看的一张券（两个小程序看到的是同一批券）
function publicVoucher(v, today) {
  const t = today || cnDay()
  const out = { _id: v._id, type: v.type === 'cash' ? 'cash' : 'drink', title: v.title, createdAt: v.createdAt }
  const lastDay = v.type === 'cash' ? v.expiresDay : v.day
  out.status = v.status === 'unused' && lastDay < t ? 'expired' : v.status
  out.lastDay = lastDay
  if (v.type === 'cash') {
    out.amount = v.amount
    out.minSpend = v.minSpend || 0
  }
  out.issuedBy = v.issuedBy || 'coffee'
  // 现在所有的券都只能在进山咖啡用
  out.usableAt = '进山咖啡'
  return out
}

function createHandlers(db, { requireAdmin }) {
  const col = () => db.collection('cw_link_rules')

  async function cardTypes() {
    return safeList(db.collection('cw_card_types').limit(100))
  }

  return {
    async listLinkRules(event, openid) {
      await requireAdmin(openid)
      const [rules, types] = await Promise.all([safeList(col().orderBy('createdAt', 'asc').limit(MAX_RULES)), cardTypes()])
      const names = {}
      types.forEach((t) => { names[t._id] = t.name })
      const counts = await Promise.all(rules.map((r) => Promise.all([
        db.collection('vouchers').where({ couponId: 'cw:' + r._id }).count(),
        db.collection('vouchers').where({ couponId: 'cw:' + r._id, status: 'used' }).count()
      ])))
      return {
        rules: rules.map((r, i) => Object.assign({}, r, {
          text: ruleText(r, names[r.cardTypeId]),
          cardName: names[r.cardTypeId] || '',
          issued: counts[i][0].total,
          used: counts[i][1].total
        })),
        cardTypes: types.map((t) => ({ _id: t._id, name: t.name }))
      }
    },

    async saveLinkRule({ rule }, openid) {
      await requireAdmin(openid)
      const r = rule || {}
      const types = await cardTypes()
      const data = cleanRule(r, types.map((t) => t._id))
      data.updatedAt = db.serverDate()
      if (r._id) {
        const res = await col().where({ _id: String(r._id) }).update({ data })
        if (!res.stats.updated) throw new BizError('这条规则不存在了')
        return { id: String(r._id) }
      }
      if ((await col().count()).total >= MAX_RULES) throw new BizError('送券规则最多 ' + MAX_RULES + ' 条')
      data.createdAt = db.serverDate()
      const added = await col().add({ data })
      return { id: added._id }
    },

    async setLinkRuleFlags({ id, enabled }, openid) {
      await requireAdmin(openid)
      if (typeof enabled !== 'boolean') throw new BizError('参数不对')
      const res = await col().where({ _id: String(id || '') }).update({ data: { enabled, updatedAt: db.serverDate() } })
      if (!res.stats.updated) throw new BizError('这条规则不存在了')
      return true
    },

    // 删掉规则不影响已经发出去的券
    async deleteLinkRule({ id }, openid) {
      await requireAdmin(openid)
      await col().where({ _id: String(id || '') }).remove()
      return true
    }
  }
}

module.exports = { TRIGGERS, issue, revoke, publicVoucher, ruleText, createHandlers }
