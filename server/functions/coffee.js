// 咖啡模块：菜单、下单（含预约）、微信支付、余额支付、订单处理、商品分类桌台管理、代金券、集星。
// 读写 coffee_ 开头的集合；vouchers 里是顾客的券：赠饮券（书籍模块包天时发放）和在领券中心领的代金券，下单时核销；
// 用会员余额付款时通过 wallet.js 扣、退余额；集星通过 stars.js 给星、扣星（星星记在 members 上）；
// 读 settings 里的支付设置、营业时间、会员设置和集星设置。
const cloud = require('../platform')
const {
  COFFEE_ROLES,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  requireRole,
  nextSeq,
  dayRange,
  fetchAll,
  createMain
} = require('./base')
const { MAX_PRICE, isFen, buildLines, sanitizeSpecs, applyVouchers, couponDiscount, pickCoupon } = require('./pricing')
const pay = require('./pay')
const { readShop, hoursOf, reserveSlots } = require('./shop')
const wallet = require('./wallet')
const stars = require('./stars')
const notify = require('./notify')
const DEMO_MENU = require('./coffee-demo')

const db = cloud.database()
const _ = db.command

const STATUSES = ['pending', 'making', 'done', 'cancelled']
// 订单状态只能按这个方向走
const NEXT_STATUS = {
  pending: ['making', 'cancelled'],
  making: ['done', 'cancelled']
}
const STATUS_TIME_FIELD = { making: 'makingAt', done: 'doneAt', cancelled: 'cancelledAt' }
const TABLE_NO_RE = /^[A-Za-z0-9-]{1,8}$/
const DAY_MS = 24 * 3600 * 1000
// 预约单下单后 15 分钟内要付款；到点后再等 2 分钟才取消，免得顾客正在付款时被取消
const RESERVE_PAY_MINUTES = 15
const RESERVE_EXPIRE_GRACE = 2 * 60000
// 后台订单列表里，预约单排在约定时间前 10 分钟的位置
const RESERVE_PREP_MINUTES = 10
// 代金券：减免最多 200 元，有效期最长一年，每人最多领 10 张
const MAX_COUPON_AMOUNT = 20000
const MAX_COUPON_DAYS = 365
const MAX_COUPON_PER_USER = 10
const MAX_COUPON_TOTAL = 100000

const col = (name) => db.collection(name)

async function findOne(name, where) {
  const res = await col(name).where(where).limit(1).get()
  return res.data[0] || null
}

function makeOrderNo() {
  return 'JS' + cnStamp() + String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function formatOrder(order) {
  const out = Object.assign({}, order)
  delete out._openid
  return out
}

function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g
  const pa = String(a).match(re) || []
  const pb = String(b).match(re) || []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === y) continue
    if (/^\d/.test(x) && /^\d/.test(y)) return Number(x) - Number(y)
    return x < y ? -1 : 1
  }
  return pa.length - pb.length
}

function toSort(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

async function safeList(query) {
  try {
    return (await query.get()).data
  } catch (e) {
    if (isMissingCollection(e)) return []
    throw e
  }
}

// 金额（分）写成元，例如 3000 → 30，1250 → 12.5
function yuan(fen) {
  return (fen / 100).toFixed(2).replace(/\.?0+$/, '')
}

// 顾客今天能用的赠饮券；ids 不传时返回全部。代金券没有 day 字段，不会混进来
function usableVouchers(openid, ids) {
  const where = { _openid: openid, status: 'unused', day: cnDay() }
  if (ids) where._id = _.in(ids)
  return safeList(col('vouchers').where(where).limit(50))
}

// 顾客手里没过期、没用掉的代金券；id 不传时返回全部
function usableCoupons(openid, id) {
  const where = { _openid: openid, type: 'cash', status: 'unused', expiresDay: _.gte(cnDay()) }
  if (id) where._id = String(id)
  return safeList(col('vouchers').where(where).orderBy('expiresDay', 'asc').limit(100))
}

function couponOption(c, left) {
  return { id: c._id, title: c.title, amount: c.amount, minSpend: c.minSpend || 0, expiresDay: c.expiresDay, discount: couponDiscount(c, left) }
}

function publicCoupon(c, mine) {
  const left = c.total ? Math.max(0, c.total - (c.claimed || 0)) : null
  const perUser = c.perUser || 1
  return {
    _id: c._id,
    title: c.title,
    amount: c.amount,
    minSpend: c.minSpend || 0,
    validDays: c.validDays,
    perUser,
    left, // 还剩几张；null 表示不限量
    mine, // 自己已经领了几张
    soldOut: left === 0,
    canClaim: left !== 0 && mine < perUser
  }
}

// 预约要先在线付款：开通了微信支付，或者开了会员储值（用余额付）才能约
function reserveOpen(paySettings, walletSettings) {
  return !!(paySettings.payEnabled || walletSettings.enabled)
}

// 预约的时间要是营业时间里还能选的那几档
async function checkReserveAt(reserveAt) {
  const slots = reserveSlots(hoursOf(await readShop(db)))
  if (!slots.some((s) => s.at === reserveAt)) throw new BizError('这个时间约不了了，请重新选一个时间', 'RESERVE_SLOT')
}

// 余额流水里写的内容，比如「点单 拿铁 等 3 件」
function linesTitle(lines) {
  const count = lines.reduce((n, l) => n + l.qty, 0)
  return '点单 ' + (lines[0] ? lines[0].name : '') + (count > 1 ? ' 等 ' + count + ' 件' : '')
}

// 余额付的单取消时退回余额；同一单只退一次
function refundToBalance(order) {
  return wallet.refund(db, order._openid, order.payFee, {
    title: '订单取消退回 取餐号 ' + order.pickupNo,
    refType: 'coffee',
    refId: order._id,
    refNo: order.orderNo
  }, async () => {
    const res = await col('coffee_orders')
      .where({ _id: order._id, payStatus: 'paid', payMethod: 'balance' })
      .update({ data: { payStatus: 'refunded', refundedAt: db.serverDate(), updatedAt: db.serverDate() } })
    return res.stats.updated > 0
  })
}

function payDeadline(order) {
  return new Date(order.createdAt).getTime() + RESERVE_PAY_MINUTES * 60000
}

function isOverdue(order) {
  return !!order.awaitingPay && order.status === 'pending' && order.payStatus === 'unpaid' &&
    Date.now() >= payDeadline(order) + RESERVE_EXPIRE_GRACE
}

// 超时没付的预约单：先向微信查一次，真付了就标成已付；没付就取消，退回用掉的券
async function expireReservation(order) {
  if (order.payOutTradeNo && (await markWechatPaid(order, await pay.queryPaid(order.payOutTradeNo)))) return false
  const res = await col('coffee_orders')
    .where({ _id: order._id, status: 'pending', payStatus: 'unpaid' })
    .update({ data: { status: 'cancelled', cancelReason: '超时未付款', cancelledAt: db.serverDate(), updatedAt: db.serverDate() } })
  if (res.stats.updated) await releaseDiscounts(order)
  return !!res.stats.updated
}

// 服务器每分钟跑一次，把超时没付的预约单取消掉
async function expireReservations() {
  const cutoff = new Date(Date.now() - RESERVE_PAY_MINUTES * 60000 - RESERVE_EXPIRE_GRACE)
  const list = await safeList(col('coffee_orders')
    .where({ awaitingPay: true, status: 'pending', payStatus: 'unpaid', createdAt: _.lt(cutoff) })
    .limit(50))
  let count = 0
  for (const order of list) {
    if (await expireReservation(order)) count++
  }
  return count
}

// 读到单个订单时顺手检查是不是超时了（服务器刚重启、定时任务还没跑的时候）
async function freshOrder(order) {
  if (!order || !isOverdue(order)) return order
  await expireReservation(order)
  return findOne('coffee_orders', { _id: order._id })
}

function voucherIdList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((id) => typeof id === 'string').slice(0, 20)
}

// 订单取消时把用掉的赠饮券、代金券和兑换用的星星退回去；星星同一单只退一次
async function releaseDiscounts(order) {
  const ids = (order.vouchers || []).map((v) => v.id)
  if (order.coupon) ids.push(order.coupon.id)
  if (ids.length) {
    await col('vouchers')
      .where({ _id: _.in(ids), status: 'used', orderNo: order.orderNo })
      .update({ data: { status: 'unused', orderNo: '', orderId: '', usedAt: null } })
  }
  const r = order.starRedeem
  if (r) {
    await stars.giveBack(db, order._openid, r.stars, r.lots, { title: '订单取消退回 取餐号 ' + order.pickupNo, refType: 'coffee', refId: order._id, refNo: order.orderNo }, async () => {
      const res = await col('coffee_orders').where({ _id: order._id, starsReturned: _.neq(true) }).update({ data: { starsReturned: true } })
      return res.stats.updated > 0
    })
  }
}

// 集星：这单用星换哪一杯、出餐后能得几颗星。covered 是每行已经被赠饮券抵掉几杯。
// 星星够、有能换的商品时 redeem 是能换的那杯（单价最高的，每单最多换一杯）；useStars 为 true 才真的换。
// 免费的杯（赠饮券、用星换的）不得星。
function planStars(lines, covered, settings, balance, useStars) {
  if (!settings.enabled) return { redeem: null, used: false, earn: 0 }
  let redeem = null
  let after = covered
  if (balance >= settings.need) {
    const productIds = lines.filter((l) => stars.redeemable(settings, l.categoryId)).map((l) => l.productId)
    if (productIds.length) {
      const res = applyVouchers(lines, [{ _id: 'stars', title: '集星兑换', productIds, maxFee: settings.maxFee }], covered)
      const a = res.applied[0]
      if (a) {
        redeem = { stars: settings.need, productId: a.productId, name: a.name, discount: a.discount }
        if (useStars) after = res.covered
      }
    }
  }
  const earn = lines.reduce((n, l, i) => n + (stars.earns(settings, l.categoryId) ? l.qty - after[i] : 0), 0)
  return { redeem, used: !!(useStars && redeem), earn }
}

// 顾客现在能用几颗星（过期的不算）
function liveStarCount(member, settings) {
  return member ? stars.liveStars(member, settings).stars : 0
}

// 出餐了、钱也收了，就给星；出餐、收款、微信到账、余额付都会调。给星出错不影响出餐和收款，只记日志
async function creditStars(id) {
  try {
    const order = await findOne('coffee_orders', { _id: id })
    if (!order || !order.starsEarn || order.starsCredited || order.status !== 'done' || order.payStatus !== 'paid') return
    await stars.credit(db, order, async () => {
      const res = await col('coffee_orders')
        .where({ _id: order._id, starsCredited: _.neq(true), status: 'done', payStatus: 'paid' })
        .update({ data: { starsCredited: true, starsCreditedAt: db.serverDate() } })
      return res.stats.updated > 0
    })
  } catch (e) {
    console.error('集星到账失败', id, e)
  }
}

// 设了有效期时清掉过期的星星；服务器每分钟调一次，实际一小时最多跑一次
let starSweepAt = 0
async function expireStars() {
  if (Date.now() - starSweepAt < 3600 * 1000) return 0
  starSweepAt = Date.now()
  return stars.expireAll(db)
}

async function coffeeCategories() {
  return (await safeList(col('coffee_categories').orderBy('sort', 'asc').limit(100))).map((c) => ({ _id: c._id, name: c.name }))
}

// 集星规则里选的分类换成名字给顾客看；删掉的分类不显示
function categoryNames(ids, categories) {
  return ids.map((id) => categories.find((c) => c._id === id)).filter(Boolean).map((c) => c.name)
}

async function loadLines(items) {
  const ids = []
  ;(Array.isArray(items) ? items : []).forEach((i) => {
    if (i && typeof i.productId === 'string' && ids.indexOf(i.productId) === -1) ids.push(i.productId)
  })
  const res = ids.length
    ? await col('coffee_products').where({ _id: _.in(ids) }).limit(100).get()
    : { data: [] }
  return buildLines(res.data, items)
}

function formatVoucher(v, today) {
  if (v.type === 'cash') {
    return {
      _id: v._id,
      type: 'cash',
      title: v.title,
      amount: v.amount,
      minSpend: v.minSpend || 0,
      expiresDay: v.expiresDay,
      status: v.status === 'unused' && v.expiresDay < today ? 'expired' : v.status,
      createdAt: v.createdAt
    }
  }
  return {
    _id: v._id,
    type: 'drink',
    title: v.title,
    productNames: v.productNames || [],
    maxFee: v.maxFee || 0,
    day: v.day,
    status: v.status === 'unused' && v.day < today ? 'expired' : v.status,
    createdAt: v.createdAt
  }
}

// 微信支付成功：核对金额后标记已付。订单如果已经取消了（顾客付款途中取消），直接原路退回。
async function markWechatPaid(order, paid) {
  if (!paid || paid.totalFee !== order.payFee) {
    if (paid) console.error('pay amount mismatch', order.orderNo, paid.totalFee, order.payFee)
    return false
  }
  const res = await col('coffee_orders')
    .where({ _id: order._id, payStatus: 'unpaid' })
    .update({ data: { payStatus: 'paid', payMethod: 'wechat', awaitingPay: false, transactionId: paid.transactionId, paidAt: db.serverDate(), updatedAt: db.serverDate() } })
  if (res.stats.updated && order.status === 'cancelled') await refundOrder(Object.assign({}, order, { payStatus: 'paid', payMethod: 'wechat' }))
  // 出餐以后才付的，付了就给星
  if (res.stats.updated) await creditStars(order._id)
  if (!res.stats.updated) {
    // 刚好用余额付掉了，微信这笔要退回去。吧台收款的不自动退：可能是店员看了顾客的微信付款记录才点的已收款
    const now = await findOne('coffee_orders', { _id: order._id })
    if (now && now.payMethod === 'balance') await refundDuplicate(now, paid)
  }
  return true
}

// 同一单已经用余额付过，微信那边又付了一次：把微信这笔原路退回
async function refundDuplicate(order, paid) {
  if (!paid || order.dupRefunded) return
  await pay.refund({ outTradeNo: order.payOutTradeNo || order.orderNo, outRefundNo: 'RD' + order.orderNo, totalFee: paid.totalFee })
  await col('coffee_orders').doc(order._id).update({ data: { dupRefunded: true, dupTransactionId: paid.transactionId, updatedAt: db.serverDate() } })
}

async function refundOrder(order) {
  await pay.refund({
    outTradeNo: order.payOutTradeNo || order.orderNo,
    outRefundNo: 'R' + order.orderNo,
    totalFee: order.payFee
  })
  await col('coffee_orders').doc(order._id).update({ data: { payStatus: 'refunded', refundedAt: db.serverDate(), updatedAt: db.serverDate() } })
}

// 微信支付通知（服务器收到 /pay/notify/coffee 后调用）
async function onPayNotify({ outTradeNo }) {
  if (typeof outTradeNo !== 'string' || outTradeNo.indexOf('JS') !== 0) return
  const order = await findOne('coffee_orders', { orderNo: outTradeNo })
  if (!order) return
  if (order.payStatus === 'unpaid') await markWechatPaid(order, await pay.queryPaid(outTradeNo))
  else if (order.payMethod === 'balance' && order.payOutTradeNo) await refundDuplicate(order, await pay.queryPaid(outTradeNo))
}

async function deleteFiles(fileIds) {
  const list = fileIds.filter((id) => typeof id === 'string' && id.indexOf('/uploads/') === 0)
  if (!list.length) return
  try {
    await cloud.deleteFile({ fileList: list })
  } catch (e) {
    console.warn('deleteFile failed', e)
  }
}

const handlers = {
  // ---------- 顾客端 ----------

  async getMenu() {
    try {
      const [cats, prods] = await Promise.all([
        col('coffee_categories').orderBy('sort', 'asc').limit(100).get(),
        col('coffee_products').where({ onShelf: true }).orderBy('sort', 'asc').limit(500).get()
      ])
      const products = prods.data.map((p) => ({
        _id: p._id,
        categoryId: p.categoryId,
        name: p.name,
        desc: p.desc || '',
        image: p.image || '',
        price: p.price,
        specs: p.specs || [],
        soldOut: !!p.soldOut
      }))
      const used = {}
      products.forEach((p) => { used[p.categoryId] = true })
      const categories = cats.data
        .filter((c) => used[c._id])
        .map((c) => ({ _id: c._id, name: c.name }))
      return { categories, products }
    } catch (e) {
      if (isMissingCollection(e)) return { categories: [], products: [] }
      throw e
    }
  },

  // 结算页算价：按数据库价格算总价，自动用上今天能用的赠饮券（noVouchers 为 true 时不用），
  // 再挑一张代金券（couponId 传 '' 表示不用）。
  // 预约时 reserve 传 true，返回能选的时间；reserveAt 是选中的那一档，没选或者选的不能约了就用最早的一档。
  // useStars 为 true 时用星免费换一杯（星星够才换得了）。
  async quote({ items, couponId, reserve, reserveAt, noVouchers, useStars }, openid) {
    const { lines, total } = await loadLines(items)
    const [settings, walletInfo, templates, starSettings, member] = await Promise.all([
      pay.getSettings(db),
      wallet.walletInfo(db, openid),
      notify.templateIds(db),
      stars.readSettings(db),
      wallet.findMember(db, openid)
    ])
    let reservation = null
    if (reserve) {
      const open = reserveOpen(settings, walletInfo)
      const slots = open ? reserveSlots(hoursOf(await readShop(db))) : []
      const chosen = slots.find((s) => s.at === reserveAt) || slots[0] || null
      reservation = { enabled: open, slots, reserveAt: chosen ? chosen.at : null, label: chosen ? chosen.label : '' }
    }
    // 赠饮券当天有效，预约明天的单用不了
    const vouchers = reservation && reservation.reserveAt && cnDay(reservation.reserveAt) !== cnDay() ? [] : await usableVouchers(openid)
    const { applied, discount, covered } = applyVouchers(lines, noVouchers ? [] : vouchers)
    const starBalance = liveStarCount(member, starSettings)
    const plan = planStars(lines, covered, starSettings, starBalance, useStars === true)
    const starFee = plan.used ? plan.redeem.discount : 0
    const left = total - discount - starFee
    const coupons = await usableCoupons(openid)
    const picked = pickCoupon(coupons, left, couponId)
    const couponFee = picked.discount
    return {
      total,
      vouchers: vouchers.length,
      applied,
      voucherFee: discount,
      // 集星：没开时是 null。redeem 是能免费换的那杯（星星不够或者没有能换的商品时是 null），used 表示这次算价用上了
      stars: starSettings.enabled ? { balance: starBalance, need: starSettings.need, redeem: plan.redeem, used: plan.used, earn: plan.earn } : null,
      starFee,
      coupons: coupons.map((c) => couponOption(c, left)).sort((a, b) => b.discount - a.discount),
      coupon: picked.coupon ? { id: picked.coupon._id, title: picked.coupon.title, discount: couponFee } : null,
      couponFee,
      discountFee: discount + starFee + couponFee,
      payFee: left - couponFee,
      pay: pay.publicPay(settings),
      // 会员余额：enabled 是店里开没开储值，余额有钱时没开也能用
      wallet: { enabled: walletInfo.enabled, balance: walletInfo.balance, memberNo: walletInfo.memberNo },
      reserve: reservation,
      // 取餐通知的订阅消息模板：有的话下单时请顾客允许
      notifyTemplate: templates.orderReady
    }
  },

  // payBy 传 'balance' 表示用会员余额付，下单时直接扣；subscribed 为 true 表示顾客允许了取餐通知；
  // useStars 为 true 表示用星免费换一杯，下单时扣星
  async createOrder({ items, mode, tableNo, remark, voucherIds, couponId, reserveAt, payBy, subscribed, useStars }, openid) {
    if (mode !== 'dine_in' && mode !== 'takeaway') throw new BizError('请选择堂食或外带')
    const { lines, total } = await loadLines(items)
    const reserving = reserveAt !== undefined && reserveAt !== null
    const paySettings = await pay.getSettings(db)
    if (reserving) {
      if (!reserveOpen(paySettings, await wallet.readSettings(db))) throw new BizError('店里暂时没开放预约', 'RESERVE_DISABLED')
      await checkReserveAt(reserveAt)
    }

    // 预约的人还没到店，不带桌号
    let table = ''
    if (!reserving && mode === 'dine_in' && tableNo) {
      const t = await findOne('coffee_tables', { tableNo: String(tableNo) })
      if (!t) throw new BizError('这个桌码已失效，请重新扫码，或者不选桌号直接下单', 'TABLE_INVALID')
      table = t.tableNo
    }

    // 赠饮券：带条件逐张核销，任何一张对不上就全部退回
    const ids = voucherIdList(voucherIds)
    if (ids.length && reserving && cnDay(reserveAt) !== cnDay()) {
      throw new BizError('赠饮券当天有效，预约明天的单用不了', 'VOUCHER_CHANGED')
    }
    const vouchers = ids.length ? await usableVouchers(openid, ids) : []
    if (vouchers.length !== ids.length) throw new BizError('赠饮券有变化，请重新确认订单', 'VOUCHER_CHANGED')
    const { applied, discount, covered } = applyVouchers(lines, vouchers)

    // 集星：用星换一杯（赠饮券抵完以后挑），再算出餐后能得几颗星
    const starSettings = await stars.readSettings(db)
    const starBalance = useStars === true ? liveStarCount(await wallet.findMember(db, openid), starSettings) : 0
    const plan = planStars(lines, covered, starSettings, starBalance, useStars === true)
    if (useStars === true && !plan.used) throw new BizError('集星兑换有变化，请重新确认订单', 'STARS_CHANGED')
    const starFee = plan.used ? plan.redeem.discount : 0

    // 代金券：一单最多一张，门槛按用完赠饮券和集星兑换以后的金额算
    let coupon = null
    if (couponId) {
      const found = (await usableCoupons(openid, couponId))[0]
      const fee = couponDiscount(found, total - discount - starFee)
      if (!fee) throw new BizError('代金券有变化，请重新确认订单', 'VOUCHER_CHANGED')
      coupon = { id: found._id, title: found.title, discount: fee }
    }
    const couponFee = coupon ? coupon.discount : 0
    const payFee = total - discount - starFee - couponFee
    const byBalance = payBy === 'balance' && payFee > 0
    if (reserving && payFee > 0 && !byBalance && !paySettings.payEnabled) {
      throw new BizError('店里还没开通微信支付，预约请用会员余额付款', 'RESERVE_DISABLED')
    }
    if (byBalance) {
      const member = await wallet.findMember(db, openid)
      if (!member || member.balance < payFee) throw new BizError('余额不够了，换个付款方式，或者先充值', 'BALANCE_LOW')
    }

    const orderNo = makeOrderNo()
    const claimed = []
    const release = () => (claimed.length
      ? col('vouchers').where({ _id: _.in(claimed), orderNo }).update({ data: { status: 'unused', orderNo: '', usedAt: null } })
      : Promise.resolve())
    const claims = applied.map((a) => ({ _id: a.id, _openid: openid, status: 'unused' }))
    if (coupon) claims.push({ _id: coupon.id, _openid: openid, type: 'cash', status: 'unused' })
    for (const where of claims) {
      const res = await col('vouchers').where(where).update({ data: { status: 'used', orderNo, usedAt: db.serverDate() } })
      if (!res.stats.updated) {
        await release()
        throw new BizError(where.type === 'cash' ? '代金券有变化，请重新确认订单' : '赠饮券有变化，请重新确认订单', 'VOUCHER_CHANGED')
      }
      claimed.push(where._id)
    }

    // 用星换的：先扣星，下单失败再退回去
    let starRedeem = null
    if (plan.used) {
      try {
        const res = await stars.redeem(db, openid, plan.redeem.stars, { title: '换一杯 ' + plan.redeem.name, refType: 'coffee', refNo: orderNo })
        starRedeem = Object.assign({}, plan.redeem, { lots: res.taken })
      } catch (e) {
        await release()
        throw e
      }
    }
    const undoStars = () => (starRedeem
      ? stars.giveBack(db, openid, starRedeem.stars, starRedeem.lots, { title: '下单没成功，退回', refType: 'coffee', refNo: orderNo })
      : Promise.resolve())

    // 余额付：先扣钱，下单失败再退回去
    let charged = false
    if (byBalance) {
      try {
        await wallet.pay(db, openid, payFee, { title: linesTitle(lines), refType: 'coffee', refNo: orderNo })
        charged = true
      } catch (e) {
        await release()
        await undoStars()
        throw e
      }
    }

    // 预约单算在约定的那天，取餐号也用那天的
    const day = reserving ? cnDay(reserveAt) : cnDay()
    let added
    try {
      const seq = await nextSeq(db, 'coffee-pickup-' + day)
      const order = {
        _openid: openid,
        orderNo,
        pickupNo: String(seq).padStart(3, '0'),
        seq, // 当天第几单，后台按它排序
        day,
        mode,
        tableNo: table,
        items: lines,
        totalFee: total,
        vouchers: applied,
        coupon,
        couponFee,
        starRedeem, // 用星换的那杯 { stars, productId, name, discount, lots（扣掉的批次，取消时按原来的日子退回） }
        starFee,
        discountFee: discount + starFee + couponFee, // 赠饮券、集星兑换和代金券一共抵了多少
        payFee,
        starsEarn: plan.earn, // 出餐、收款以后得几颗星
        remark: cleanText(remark, 50),
        // 券和星全抵了就不用再付钱；余额付的下单时就扣了
        payStatus: payFee === 0 || byBalance ? 'paid' : 'unpaid',
        payMethod: payFee === 0 ? 'voucher' : (byBalance ? 'balance' : 'counter'), // 微信付款后改成 wechat
        status: 'pending',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      if (byBalance) order.paidAt = db.serverDate()
      if (subscribed === true) order.notifyReady = true
      if (reserving) {
        order.reserveAt = new Date(reserveAt)
        // 预约要先在线付款，付完店员才看得到
        order.awaitingPay = order.payStatus === 'unpaid'
      }
      added = await col('coffee_orders').add({ data: order })
    } catch (e) {
      await release()
      await undoStars()
      if (charged) await wallet.refund(db, openid, payFee, { title: '下单没成功，退回', refType: 'coffee', refNo: orderNo })
      throw e
    }
    if (claimed.length) await col('vouchers').where({ _id: _.in(claimed), orderNo }).update({ data: { orderId: added._id } })
    return { id: added._id }
  },

  // 我的券（赠饮券和代金券）：现在能用的，和最近用过、过期的
  async myVouchers(event, openid) {
    const today = cnDay()
    try {
      const res = await col('vouchers').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(100).get()
      const list = res.data.map((v) => formatVoucher(v, today))
      return {
        usable: list.filter((v) => v.status === 'unused'),
        others: list.filter((v) => v.status !== 'unused')
      }
    } catch (e) {
      if (isMissingCollection(e)) return { usable: [], others: [] }
      throw e
    }
  },

  async getOrder({ id }, openid) {
    let order = await findOne('coffee_orders', { _id: String(id || '') })
    if (!order) throw new BizError('订单不存在')
    if (order._openid !== openid) await requireRole(db, openid, COFFEE_ROLES)
    order = await freshOrder(order)
    const settings = await pay.getSettings(db)
    const out = Object.assign(formatOrder(order), { pay: pay.publicPay(settings) })
    if (order.awaitingPay && order.payStatus === 'unpaid' && order.status === 'pending') out.payDeadline = payDeadline(order)
    // 自己没付的单：带上余额，详情页可以直接用余额付
    if (order._openid === openid && order.payStatus === 'unpaid' && order.status !== 'cancelled') {
      const w = await wallet.walletInfo(db, openid)
      out.wallet = { enabled: w.enabled, balance: w.balance }
    }
    return out
  },

  // 顾客用微信支付：返回 wx.requestPayment 要的参数
  async payOrder({ id }, openid) {
    const order = await freshOrder(await findOne('coffee_orders', { _id: String(id || ''), _openid: openid }))
    if (!order) throw new BizError('订单不存在')
    if (order.status === 'cancelled') throw new BizError('订单已经取消了')
    if (order.payStatus !== 'unpaid') throw new BizError('这单已经付过了')
    // 预约单要在 15 分钟内付款；微信那边最多再多给一分多钟，取消前一定已经付不了了
    let timeExpire
    if (order.awaitingPay) {
      const deadline = payDeadline(order)
      if (Date.now() >= deadline) throw new BizError('超过 ' + RESERVE_PAY_MINUTES + ' 分钟没付款，这单预约会自动取消，请重新下单', 'RESERVE_EXPIRED')
      timeExpire = Math.max(deadline, Date.now() + 70 * 1000)
    }
    const settings = await pay.getSettings(db)
    const payment = await pay.unifiedOrder(settings, {
      body: '进山咖啡-取餐号' + order.pickupNo,
      outTradeNo: order.orderNo,
      totalFee: order.payFee,
      openid,
      notify: 'coffee',
      timeExpire
    })
    await col('coffee_orders').doc(order._id).update({ data: { payOutTradeNo: order.orderNo, updatedAt: db.serverDate() } })
    return { payment }
  },

  // 顾客用会员余额付一个还没付的单（包括等付款的预约单）
  async payWithBalance({ id }, openid) {
    const order = await freshOrder(await findOne('coffee_orders', { _id: String(id || ''), _openid: openid }))
    if (!order) throw new BizError('订单不存在')
    if (order.status === 'cancelled') throw new BizError('订单已经取消了')
    if (order.payStatus !== 'unpaid') throw new BizError('这单已经付过了')
    if (order.awaitingPay && Date.now() >= payDeadline(order)) {
      throw new BizError('超过 ' + RESERVE_PAY_MINUTES + ' 分钟没付款，这单预约会自动取消，请重新下单', 'RESERVE_EXPIRED')
    }
    // 拉起过微信支付的，先查一下是不是其实已经付了
    if (order.payOutTradeNo && (await markWechatPaid(order, await pay.queryPaid(order.payOutTradeNo)))) return { payStatus: 'paid' }
    const log = { refType: 'coffee', refId: order._id, refNo: order.orderNo }
    await wallet.pay(db, openid, order.payFee, Object.assign({ title: '点单 取餐号 ' + order.pickupNo }, log))
    const res = await col('coffee_orders')
      .where({ _id: order._id, payStatus: 'unpaid', status: _.neq('cancelled') })
      .update({ data: { payStatus: 'paid', payMethod: 'balance', awaitingPay: false, paidAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) {
      await wallet.refund(db, openid, order.payFee, Object.assign({ title: '订单状态变了，退回' }, log))
      throw new BizError('订单状态刚刚变了，钱已经退回余额，请刷新看看')
    }
    await creditStars(order._id)
    return { payStatus: 'paid' }
  },

  // 付完款后顾客端调一下，向微信查单确认（回调慢的时候不用干等）
  async confirmPay({ id }, openid) {
    const order = await findOne('coffee_orders', { _id: String(id || '') })
    if (!order) throw new BizError('订单不存在')
    if (order._openid !== openid) await requireRole(db, openid, COFFEE_ROLES)
    if (order.payStatus === 'unpaid' && order.payOutTradeNo) {
      if (await markWechatPaid(order, await pay.queryPaid(order.payOutTradeNo))) return { payStatus: 'paid' }
    }
    return { payStatus: order.payStatus }
  },

  async myOrders({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    try {
      const res = await col('coffee_orders')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .skip(p * size)
        .limit(size)
        .get()
      const orders = []
      for (const o of res.data) orders.push(formatOrder(await freshOrder(o)))
      return { orders, hasMore: res.data.length === size }
    } catch (e) {
      if (isMissingCollection(e)) return { orders: [], hasMore: false }
      throw e
    }
  },

  async cancelOrder({ id }, openid) {
    const order = await findOne('coffee_orders', { _id: String(id || ''), _openid: openid })
    if (!order) throw new BizError('订单不存在')
    const res = await col('coffee_orders')
      .where({ _id: order._id, _openid: openid, status: 'pending', payStatus: 'unpaid' })
      .update({ data: { status: 'cancelled', cancelledAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('订单已经开始处理，不能取消了，请联系店员')
    await releaseDiscounts(order)
    return true
  },

  // ---------- 咖啡后台：订单 ----------

  // 还没付款的预约单店员看不到；预约单排在约定时间前 10 分钟的位置
  async listOrders({ status, day }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const d = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : cnDay()
    const st = STATUSES.indexOf(status) === -1 ? 'pending' : status
    const active = st === 'pending' || st === 'making'
    const visible = (where) => Object.assign({ day: d, awaitingPay: _.neq(true) }, where)
    const [list, counts, pending] = await Promise.all([
      col('coffee_orders').where(visible({ status: st })).orderBy('seq', active ? 'asc' : 'desc').limit(100).get(),
      Promise.all(STATUSES.map((s) => col('coffee_orders').where(visible({ status: s })).count())),
      col('coffee_orders').where(visible({ status: 'pending' })).field({ _id: true }).limit(100).get()
    ])
    const countMap = {}
    STATUSES.forEach((s, i) => { countMap[s] = counts[i].total })
    const queueAt = (o) => (o.reserveAt
      ? new Date(o.reserveAt).getTime() - RESERVE_PREP_MINUTES * 60000
      : new Date(o.createdAt).getTime())
    const orders = list.data.slice()
    if (active) orders.sort((a, b) => queueAt(a) - queueAt(b) || a.seq - b.seq)
    return {
      day: d,
      orders: orders.map(formatOrder),
      counts: countMap,
      pendingIds: pending.data.map((o) => o._id)
    }
  },

  // 收银电脑自动打小票：按 id 取新来的单（不管现在停在哪个分页）
  async ordersForPrint({ ids }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string').slice(0, 20)
    if (!list.length) return []
    const res = await col('coffee_orders').where({ _id: _.in(list), awaitingPay: _.neq(true) }).limit(20).get()
    return res.data.sort((a, b) => a.seq - b.seq).map(formatOrder)
  },

  async markPaid({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const res = await col('coffee_orders')
      .where({ _id: String(id || ''), payStatus: 'unpaid', status: _.neq('cancelled') })
      .update({ data: { payStatus: 'paid', payMethod: 'counter', paidAt: db.serverDate(), paidBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('订单已收款或已取消')
    // 先出餐后收款的，收了款再给星
    await creditStars(String(id))
    return true
  },

  async setOrderStatus({ id, status }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const order = await findOne('coffee_orders', { _id: String(id || '') })
    if (!order) throw new BizError('订单不存在')
    const allowed = NEXT_STATUS[order.status] || []
    if (allowed.indexOf(status) === -1) throw new BizError('订单状态已经变了，请刷新')
    // 微信付过款的单先原路退款，退款成功才取消；余额付的退回余额
    if (status === 'cancelled' && order.payStatus === 'paid' && order.payMethod === 'wechat') await refundOrder(order)
    if (status === 'cancelled' && order.payStatus === 'paid' && order.payMethod === 'balance') await refundToBalance(order)
    const data = { status, updatedAt: db.serverDate() }
    data[STATUS_TIME_FIELD[status]] = db.serverDate()
    // 带上原状态做条件，防止两位店员同时操作
    const res = await col('coffee_orders').where({ _id: order._id, status: order.status }).update({ data })
    if (!res.stats.updated) throw new BizError('订单状态已经变了，请刷新')
    if (status === 'cancelled') await releaseDiscounts(order)
    // 出餐了、钱也收了就给星；吧台付款还没点「已收款」的，点了再给
    if (status === 'done') await creditStars(order._id)
    // 做好了通知顾客取餐；不等微信回复，发不出去也不影响出餐
    if (status === 'done' && order.notifyReady) notify.orderReady(db, order).catch((e) => console.warn('取餐通知失败', e.message))
    return true
  },

  // 店主看账：每天的单数、收款（微信、吧台、会员余额）、赠饮券、代金券和集星兑换抵扣，以及这段时间卖得最多的商品
  async daySummary({ from, to }, openid) {
    await requireRole(db, openid, ['owner'])
    const days = dayRange(from, to)
    const orders = await fetchAll(col('coffee_orders').where({ day: _.in(days) }).orderBy('createdAt', 'asc'))
    const rows = {}
    days.forEach((d) => {
      rows[d] = { day: d, orders: 0, cancelled: 0, totalFee: 0, discountFee: 0, couponFee: 0, starFee: 0, paidFee: 0, unpaidFee: 0, wechatFee: 0, counterFee: 0, balanceFee: 0, vouchersUsed: 0, couponsUsed: 0, starCups: 0, starsIssued: 0, cancelledPaidFee: 0 }
    })
    const products = {}
    orders.forEach((o) => {
      const r = rows[o.day]
      // 没付款的预约单（包括超时取消的）不算
      if (!r || o.awaitingPay) return
      if (o.status === 'cancelled') {
        r.cancelled++
        if (o.payStatus === 'paid') r.cancelledPaidFee += o.payFee // 收了钱、还没在线退款的
        return
      }
      r.orders++
      r.totalFee += o.totalFee
      r.discountFee += o.discountFee || 0
      r.couponFee += o.couponFee || 0
      r.starFee += o.starFee || 0
      r.vouchersUsed += (o.vouchers || []).length
      if (o.coupon) r.couponsUsed++
      if (o.starRedeem) r.starCups++
      if (o.starsCredited) r.starsIssued += o.starsEarn || 0
      if (o.payStatus === 'paid') {
        r.paidFee += o.payFee
        if (o.payMethod === 'wechat') r.wechatFee += o.payFee
        else if (o.payMethod === 'balance') r.balanceFee += o.payFee // 充值时已经收过钱了
        else r.counterFee += o.payFee
      } else {
        r.unpaidFee += o.payFee
      }
      ;(o.items || []).forEach((i) => {
        const p = products[i.productId] || (products[i.productId] = { productId: i.productId, name: i.name, qty: 0, amount: 0 })
        p.qty += i.qty
        p.amount += i.subtotal
      })
    })
    const list = days.map((d) => rows[d])
    const totals = list.reduce((acc, r) => {
      Object.keys(r).forEach((k) => { if (k !== 'day') acc[k] = (acc[k] || 0) + r[k] })
      return acc
    }, {})
    const top = Object.keys(products).map((k) => products[k]).sort((a, b) => b.qty - a.qty || b.amount - a.amount)
    return { days: list, totals, products: top }
  },

  // ---------- 集星 ----------

  // 我的星星：规则、现在几颗、还有几颗等出餐后到账、最早一批什么时候过期、变动记录
  async myStars({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const [settings, member, categories] = await Promise.all([stars.readSettings(db), wallet.findMember(db, openid), coffeeCategories()])
    const [logs, open] = await Promise.all([
      safeList(col('star_logs').where({ _openid: openid }).orderBy('createdAt', 'desc').skip(p * size).limit(size)),
      p ? [] : safeList(col('coffee_orders').where({ _openid: openid, status: _.in(['pending', 'making']), starsEarn: _.gt(0) }).limit(50))
    ])
    const live = stars.liveStars(member, settings)
    return {
      enabled: settings.enabled,
      need: settings.need,
      maxFee: settings.maxFee,
      validDays: settings.validDays,
      // earnAll / redeemAll 为 true 表示全部商品，否则是 earnNames / redeemNames 里这几个分类
      earnAll: settings.earnAll,
      earnNames: categoryNames(settings.earnCategories, categories),
      redeemAll: settings.redeemAll,
      redeemNames: categoryNames(settings.redeemCategories, categories),
      stars: live.stars,
      expiring: live.expiring,
      pending: open.filter((o) => !o.awaitingPay).reduce((n, o) => n + o.starsEarn, 0),
      memberNo: member ? member.memberNo : '',
      logs: logs.map((l) => stars.publicLog(l)),
      hasMore: logs.length === size
    }
  },

  // 集星设置（店主）：规则、咖啡分类，以及顾客手里一共有多少星、换过多少杯
  async getStarSettings(event, openid) {
    await requireRole(db, openid, ['owner'])
    const [settings, categories] = await Promise.all([stars.readSettings(db), coffeeCategories()])
    let members = []
    try {
      members = await fetchAll(col('members').where({ starsUpdatedAt: _.gt(new Date(0)) }).field({ stars: true, starsEarned: true, starsUsed: true }))
    } catch (e) {
      if (!isMissingCollection(e)) throw e
    }
    const sum = (k) => members.reduce((n, m) => n + (m[k] || 0), 0)
    return {
      settings,
      categories,
      stats: {
        holders: members.filter((m) => m.stars > 0).length,
        stars: sum('stars'),
        earned: sum('starsEarned'),
        used: sum('starsUsed')
      }
    }
  },

  async saveStarSettings({ settings }, openid) {
    await requireRole(db, openid, ['owner'])
    const data = stars.cleanSettings(settings, (await coffeeCategories()).map((c) => c._id))
    data.updatedBy = openid
    data.updatedAt = db.serverDate()
    await col('settings').doc('stars').set({ data })
    return stars.readSettings(db)
  },

  // ---------- 领券中心（顾客） ----------

  async couponCenter(event, openid) {
    const [coupons, mine] = await Promise.all([
      safeList(col('coffee_coupons').where({ enabled: true }).orderBy('sort', 'asc').limit(100)),
      safeList(col('vouchers').where({ _openid: openid, type: 'cash' }).limit(1000))
    ])
    const count = {}
    mine.forEach((v) => { count[v.couponId] = (count[v.couponId] || 0) + 1 })
    return { coupons: coupons.map((c) => publicCoupon(c, count[c._id] || 0)) }
  },

  // 领券：排队执行，不会超发，也不会超过每人限领
  async claimCoupon({ id }, openid) {
    const couponId = String(id || '')
    return db.runTransaction(async () => {
      const c = await findOne('coffee_coupons', { _id: couponId })
      if (!c || !c.enabled) throw new BizError('这张券已经下架了', 'COUPON_GONE')
      if (c.total && (c.claimed || 0) >= c.total) throw new BizError('这张券已经被领完了', 'COUPON_SOLD_OUT')
      const perUser = c.perUser || 1
      const mine = await col('vouchers').where({ _openid: openid, type: 'cash', couponId }).count()
      if (mine.total >= perUser) {
        throw new BizError(perUser > 1 ? '这张券每人最多领 ' + perUser + ' 张，你已经领满了' : '这张券你已经领过了', 'COUPON_LIMIT')
      }
      await col('coffee_coupons').doc(c._id).update({ data: { claimed: _.inc(1) } })
      const today = cnDay()
      const voucher = {
        _openid: openid,
        type: 'cash',
        source: 'coupon',
        couponId: c._id,
        title: c.title,
        amount: c.amount,
        minSpend: c.minSpend || 0,
        claimDay: today,
        // 领取当天算第 1 天
        expiresDay: cnDay(Date.now() + (c.validDays - 1) * DAY_MS),
        status: 'unused',
        orderNo: '',
        orderId: '',
        createdAt: db.serverDate()
      }
      const added = await col('vouchers').add({ data: voucher })
      return formatVoucher(Object.assign({}, voucher, { _id: added._id, createdAt: new Date() }), today)
    })
  },

  // ---------- 代金券设置（店主） ----------

  async adminListCoupons(event, openid) {
    await requireRole(db, openid, ['owner'])
    const coupons = await safeList(col('coffee_coupons').orderBy('sort', 'asc').limit(100))
    const used = await Promise.all(coupons.map((c) => col('vouchers').where({ couponId: c._id, status: 'used' }).count()))
    return coupons.map((c, i) => Object.assign({}, c, { claimed: c.claimed || 0, used: used[i].total }))
  },

  async saveCoupon({ coupon }, openid) {
    await requireRole(db, openid, ['owner'])
    const c = coupon || {}
    const amount = Number(c.amount)
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_COUPON_AMOUNT) throw new BizError('减免金额请填 0.01 到 ' + yuan(MAX_COUPON_AMOUNT) + ' 元')
    const minSpend = c.minSpend === undefined || c.minSpend === '' || c.minSpend === null ? 0 : Number(c.minSpend)
    if (!isFen(minSpend, MAX_PRICE)) throw new BizError('使用门槛不对，没有门槛填 0')
    if (minSpend && minSpend < amount) throw new BizError('门槛不能低于减免金额，例如满 30 减 5')
    const validDays = Number(c.validDays)
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > MAX_COUPON_DAYS) throw new BizError('有效天数请填 1 到 ' + MAX_COUPON_DAYS)
    const total = c.total === undefined || c.total === '' || c.total === null ? 0 : Number(c.total)
    if (!Number.isInteger(total) || total < 0 || total > MAX_COUPON_TOTAL) throw new BizError('发放总数不对，不限量填 0')
    const perUser = c.perUser === undefined || c.perUser === '' || c.perUser === null ? 1 : Number(c.perUser)
    if (!Number.isInteger(perUser) || perUser < 1 || perUser > MAX_COUPON_PER_USER) throw new BizError('每人限领请填 1 到 ' + MAX_COUPON_PER_USER + ' 张')
    const data = {
      title: cleanText(c.title, 16) || (minSpend ? '满' + yuan(minSpend) + '减' + yuan(amount) : yuan(amount) + '元无门槛券'),
      amount,
      minSpend,
      validDays,
      total,
      perUser,
      enabled: c.enabled !== false,
      updatedAt: db.serverDate()
    }
    if (c.sort !== undefined) data.sort = toSort(c.sort)
    if (c._id) {
      const old = await findOne('coffee_coupons', { _id: String(c._id) })
      if (!old) throw new BizError('这张券不存在了')
      if (total && total < (old.claimed || 0)) throw new BizError('已经领走 ' + old.claimed + ' 张了，总数不能比这个少')
      await col('coffee_coupons').doc(old._id).update({ data })
      return { id: old._id }
    }
    const count = await col('coffee_coupons').count()
    if (count.total >= 100) throw new BizError('代金券最多 100 种，先删掉一些不用的')
    if (data.sort === undefined) data.sort = count.total
    data.claimed = 0
    data.createdAt = db.serverDate()
    const added = await col('coffee_coupons').add({ data })
    return { id: added._id }
  },

  // 停发（enabled=false）后顾客领不到了，已经领的照样能用
  async setCouponFlags({ id, enabled }, openid) {
    await requireRole(db, openid, ['owner'])
    if (typeof enabled !== 'boolean') throw new BizError('参数不对')
    const res = await col('coffee_coupons').where({ _id: String(id || '') }).update({ data: { enabled, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('这张券不存在了')
    return true
  },

  async sortCoupons({ ids }, openid) {
    await requireRole(db, openid, ['owner'])
    if (!Array.isArray(ids) || ids.length > 100) throw new BizError('排序数据不对')
    await Promise.all(ids.map((id, index) =>
      col('coffee_coupons').where({ _id: String(id) }).update({ data: { sort: index, updatedAt: db.serverDate() } })
    ))
    return true
  },

  // 删掉券的设置，顾客已经领到手的照样能用
  async deleteCoupon({ id }, openid) {
    await requireRole(db, openid, ['owner'])
    await col('coffee_coupons').where({ _id: String(id || '') }).remove()
    return true
  },

  // ---------- 咖啡后台：商品和分类 ----------

  async adminListProducts(event, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const [cats, prods] = await Promise.all([
      col('coffee_categories').orderBy('sort', 'asc').limit(100).get(),
      col('coffee_products').orderBy('sort', 'asc').limit(500).get()
    ])
    return { categories: cats.data, products: prods.data }
  },

  async getProduct({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const product = await findOne('coffee_products', { _id: String(id || '') })
    if (!product) throw new BizError('商品不存在')
    return product
  },

  async saveProduct({ product }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const p = product || {}
    const name = cleanText(p.name, 30)
    if (!name) throw new BizError('请填写商品名称')
    const price = Number(p.price)
    if (!isFen(price, MAX_PRICE)) throw new BizError('价格不对，请填 0 到 1000 元')
    const categoryId = String(p.categoryId || '')
    if (!categoryId || !(await findOne('coffee_categories', { _id: categoryId }))) {
      throw new BizError('请选择商品分类')
    }
    const specs = sanitizeSpecs(p.specs)
    const data = {
      name,
      desc: cleanText(p.desc, 60),
      categoryId,
      price,
      image: typeof p.image === 'string' ? p.image.slice(0, 500) : '',
      // 更新时用 _.set 整体替换规格数组
      specs: p._id ? _.set(specs) : specs,
      onShelf: p.onShelf !== false,
      soldOut: !!p.soldOut,
      sort: toSort(p.sort),
      updatedAt: db.serverDate()
    }
    if (p._id) {
      const old = await findOne('coffee_products', { _id: String(p._id) })
      if (!old) throw new BizError('商品不存在')
      await col('coffee_products').doc(old._id).update({ data })
      if (old.image && old.image !== data.image) await deleteFiles([old.image])
      return { id: old._id }
    }
    data.createdAt = db.serverDate()
    const added = await col('coffee_products').add({ data })
    return { id: added._id }
  },

  async setProductFlags({ id, onShelf, soldOut }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const data = { updatedAt: db.serverDate() }
    if (typeof onShelf === 'boolean') data.onShelf = onShelf
    if (typeof soldOut === 'boolean') data.soldOut = soldOut
    const res = await col('coffee_products').where({ _id: String(id || '') }).update({ data })
    if (!res.stats.updated) throw new BizError('商品不存在')
    return true
  },

  async deleteProduct({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const product = await findOne('coffee_products', { _id: String(id || '') })
    if (!product) return true
    await col('coffee_products').doc(product._id).remove()
    await deleteFiles([product.image])
    return true
  },

  async saveCategory({ id, name, sort }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const categoryName = cleanText(name, 10)
    if (!categoryName) throw new BizError('请填写分类名称')
    const dup = await findOne('coffee_categories', { name: categoryName })
    if (dup && dup._id !== id) throw new BizError('已经有「' + categoryName + '」这个分类了')
    if (id) {
      const data = { name: categoryName, updatedAt: db.serverDate() }
      if (sort !== undefined) data.sort = toSort(sort)
      const res = await col('coffee_categories').where({ _id: String(id) }).update({ data })
      if (!res.stats.updated) throw new BizError('分类不存在')
      return { id }
    }
    const count = await col('coffee_categories').count()
    const added = await col('coffee_categories').add({
      data: { name: categoryName, sort: sort === undefined ? count.total : toSort(sort), createdAt: db.serverDate(), updatedAt: db.serverDate() }
    })
    return { id: added._id }
  },

  // ids 按新的顺序排好传进来
  async sortCategories({ ids }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    if (!Array.isArray(ids) || ids.length > 100) throw new BizError('排序数据不对')
    await Promise.all(ids.map((id, index) =>
      col('coffee_categories').where({ _id: String(id) }).update({ data: { sort: index, updatedAt: db.serverDate() } })
    ))
    return true
  },

  async deleteCategory({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const used = await col('coffee_products').where({ categoryId: String(id || '') }).count()
    if (used.total) throw new BizError('这个分类下还有 ' + used.total + ' 个商品，先把商品移走或删除')
    await col('coffee_categories').where({ _id: String(id || '') }).remove()
    return true
  },

  // 第一次试用时导入示例菜单，只在一个商品都没有的时候能用
  async seedDemo(event, openid) {
    await requireRole(db, openid, ['owner'])
    const existing = await col('coffee_products').count()
    if (existing.total) throw new BizError('已经有商品了，不再导入示例菜单')
    let productCount = 0
    for (let i = 0; i < DEMO_MENU.length; i++) {
      const group = DEMO_MENU[i]
      let category = await findOne('coffee_categories', { name: group.category })
      if (!category) {
        const added = await col('coffee_categories').add({
          data: { name: group.category, sort: i, createdAt: db.serverDate(), updatedAt: db.serverDate() }
        })
        category = { _id: added._id }
      }
      for (let j = 0; j < group.products.length; j++) {
        const p = group.products[j]
        await col('coffee_products').add({
          data: {
            name: p.name,
            desc: '示例商品，请在后台改成店里的真实信息',
            categoryId: category._id,
            price: p.price,
            image: '',
            specs: sanitizeSpecs(p.specs),
            onShelf: true,
            soldOut: false,
            sort: j,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
        productCount++
      }
    }
    return { productCount }
  },

  // ---------- 咖啡后台：桌台和桌码 ----------

  async listTables(event, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const res = await col('coffee_tables').limit(200).get()
    return res.data.sort((a, b) => naturalCompare(a.tableNo, b.tableNo))
  },

  async saveTable({ tableNo }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const no = String(tableNo || '').trim().toUpperCase()
    if (!TABLE_NO_RE.test(no)) throw new BizError('桌号只能用字母、数字和横线，最多 8 位，比如 1、A3')
    if (await findOne('coffee_tables', { tableNo: no })) throw new BizError(no + ' 号桌已经有了')
    const added = await col('coffee_tables').add({
      data: { tableNo: no, qrcode: '', qrcodeEnv: '', createdAt: db.serverDate(), updatedAt: db.serverDate() }
    })
    return { id: added._id }
  },

  async deleteTable({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const table = await findOne('coffee_tables', { _id: String(id || '') })
    if (!table) return true
    await col('coffee_tables').doc(table._id).remove()
    await deleteFiles([table.qrcode])
    return true
  },

  // 生成小程序码，扫码打开点单页并带上桌号（scene=t=桌号）
  // envVersion：release 正式版（发布后才能扫开）、trial 体验版（测试用）
  async genTableCode({ id, envVersion }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const table = await findOne('coffee_tables', { _id: String(id || '') })
    if (!table) throw new BizError('桌台不存在')
    const env = envVersion === 'trial' || envVersion === 'develop' ? envVersion : 'release'
    let result
    try {
      result = await cloud.openapi.wxacode.getUnlimited({
        scene: 't=' + table.tableNo,
        page: 'pages/menu/menu',
        checkPath: false,
        envVersion: env,
        width: 600
      })
    } catch (e) {
      console.error('getUnlimited failed', e)
      throw new BizError('生成桌码失败：' + (e.errMsg || e.message || '未知错误'))
    }
    const upload = await cloud.uploadFile({
      cloudPath: 'table-codes/' + env + '/table-' + table.tableNo + '-' + Date.now() + (/png/.test(result.contentType || '') ? '.png' : '.jpg'),
      fileContent: result.buffer
    })
    await col('coffee_tables').doc(table._id).update({
      data: { qrcode: upload.fileID, qrcodeEnv: env, updatedAt: db.serverDate() }
    })
    await deleteFiles([table.qrcode])
    return { fileID: upload.fileID, envVersion: env }
  }
}

exports.main = createMain(cloud, handlers)
exports.onPayNotify = onPayNotify
exports.expireReservations = expireReservations
exports.expireStars = expireStars
