// 洗车模块（/api/carwash）：服务项目和价格、预约（时段容量、防超约）、上门（地址、服务半径、上门费）、
// 派单和技师端（接单 → 出发 → 开始服务 → 完成 → 顾客确认）、付款（洗车商户号的微信支付、会员余额、次卡、到店付款）、
// 取消和退款、洗车店设置。会员储值和次卡见 membership.js，送咖啡券见 voucher-link.js，美团抖音核销见 redeem.js，
// 它们的操作也都挂在这个模块下。读写 cw_ 开头的集合；店铺设置见 carwash-shop.js。
const crypto = require('crypto')
const cloud = require('../platform')
const {
  ROLES,
  CARWASH_ROLES,
  CARWASH_STAFF,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  getStaff,
  requireRole,
  dayRange,
  fetchAll,
  createMain
} = require('./base')
const pay = require('./pay')
const shop = require('./carwash-shop')
const membership = require('./membership')
const link = require('./voucher-link')
const redeem = require('./redeem')
const wallet = require('./wallet')

const db = cloud.database()
const _ = db.command

const SHOP = 'carwash'
const STATUS_TEXT = {
  pending: '待接单',
  confirmed: '已接单',
  departed: '技师已出发',
  serving: '服务中',
  done: '待确认完成',
  finished: '已完成',
  cancelled: '已取消'
}
// 占着时段的状态（取消了才让出来）
const OPEN = ['pending', 'confirmed', 'departed', 'serving', 'done']
// 技师往前推：到店的单没有「出发」这一步
const NEXT = { confirmed: ['departed', 'serving'], departed: ['serving'], serving: ['done'] }
const TIME_FIELD = { confirmed: 'confirmedAt', departed: 'departedAt', serving: 'servingAt', done: 'doneAt' }
// 顾客自己能取消的状态（技师出发以后要联系店里）
const CUSTOMER_CANCEL = ['pending', 'confirmed']
const MODES = { store: '到店', door: '上门' }
const PAY_BY = ['wechat', 'balance', 'later']
// 在线付款的预约 15 分钟内要付；到点后再等 2 分钟才取消，免得顾客正在付款时被取消
const PAY_MINUTES = 15
const PAY_GRACE = 2 * 60000
const MAX_SERVICES = 50
const MAX_PRICE = 1000000
const MAX_ADDRESSES = 20
const INVITE_TTL = 24 * 3600 * 1000
const PHONE_RE = /^(1\d{10}|0\d{2,3}-?\d{7,8})$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const col = (name) => db.collection(name)
const ledger = membership.ledger

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

function yuan(fen) {
  return (fen / 100).toFixed(2).replace(/\.?0+$/, '')
}

function toSort(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function makeOrderNo() {
  return 'CW' + cnStamp() + String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function staffName(staff) {
  return (staff && staff.name) || ''
}

const requireAdmin = (openid) => requireRole(db, openid, CARWASH_ROLES)
const requireStaff = (openid) => requireRole(db, openid, CARWASH_STAFF)
const isAdmin = (staff) => CARWASH_ROLES.indexOf(staff.role) !== -1

// ---------- 设置和服务项目 ----------

async function loadState() {
  const [settings, ways] = await Promise.all([shop.readSettings(db), membership.payWays()])
  const problems = shop.problems(settings, ways)
  return { settings, ways, problems, open: settings.bookingEnabled && !problems.length }
}

function publicShop(s) {
  return { shopName: s.shopName, address: s.address, phone: s.phone, location: s.location, notice: s.notice, hours: s.hours }
}

function cleanService(s) {
  const name = cleanText(s.name, 20)
  if (!name) throw new BizError('请填项目名称，比如「标准洗车」')
  const price = Number(s.price)
  if (!Number.isInteger(price) || price <= 0 || price > MAX_PRICE) throw new BizError('价格请填 0.01 到 ' + yuan(MAX_PRICE) + ' 元')
  let memberPrice = null
  if (s.memberPrice !== undefined && s.memberPrice !== null && s.memberPrice !== '') {
    memberPrice = Number(s.memberPrice)
    if (!Number.isInteger(memberPrice) || memberPrice < 0 || memberPrice > price) throw new BizError('会员价不能比原价高；没有会员价就空着')
  }
  let minutes = null
  if (s.minutes !== undefined && s.minutes !== null && s.minutes !== '') {
    minutes = Number(s.minutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new BizError('大概要多久请填 1 到 1440 分钟，不想写就空着')
  }
  const modes = Object.keys(MODES).filter((m) => Array.isArray(s.modes) && s.modes.indexOf(m) !== -1)
  if (!modes.length) throw new BizError('请选这个项目能到店做还是能上门做')
  return {
    name,
    desc: cleanText(s.desc, 60),
    image: typeof s.image === 'string' && s.image.indexOf('/uploads/') === 0 ? s.image.slice(0, 500) : '',
    price,
    memberPrice,
    minutes,
    modes,
    enabled: s.enabled !== false
  }
}

function publicService(s) {
  return {
    _id: s._id,
    name: s.name,
    desc: s.desc || '',
    image: s.image || '',
    price: s.price,
    memberPrice: Number.isInteger(s.memberPrice) ? s.memberPrice : null,
    minutes: s.minutes || null,
    modes: s.modes || []
  }
}

function enabledServices() {
  return safeList(col('cw_services').where({ enabled: true }).orderBy('sort', 'asc').limit(MAX_SERVICES))
}

async function usableService(id) {
  const s = await findOne('cw_services', { _id: String(id || '') })
  if (!s || !s.enabled) throw new BizError('这个项目已经下架了，请重新选择', 'SERVICE_GONE')
  return s
}

// 这个项目现在能约哪几种方式：项目支持、店里这种方式每段容量大于 0
function modesFor(service, s) {
  return (service.modes || []).filter((m) => shop.capacityOf(s, m) > 0)
}

// ---------- 价格：一律按数据库里的价格在服务器上算 ----------

function priceFor(service, mode, settings, member, place) {
  const isMember = wallet.isMember(member)
  const unitPrice = isMember && Number.isInteger(service.memberPrice) ? service.memberPrice : service.price
  const door = mode === 'door' ? shop.doorCharge(settings, place) : { distanceKm: 0, doorFee: 0, extraFee: 0 }
  return {
    servicePrice: service.price,
    unitPrice,
    memberPriced: unitPrice !== service.price,
    distanceKm: door.distanceKm,
    doorFee: door.doorFee,
    extraFee: door.extraFee,
    totalFee: unitPrice + door.doorFee + door.extraFee
  }
}

// ---------- 地址 ----------

function cleanAddress(a) {
  const name = cleanText(a.name, 10)
  if (!name) throw new BizError('请填联系人')
  const phone = String(a.phone || '').trim()
  if (!PHONE_RE.test(phone)) throw new BizError('联系电话格式不对')
  const place = cleanText(a.place, 60)
  if (!place) throw new BizError('请在地图上选位置')
  const lat = Number(a.location && a.location.lat)
  const lng = Number(a.location && a.location.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new BizError('请在地图上选位置')
  return {
    name,
    phone,
    place,
    detail: cleanText(a.detail, 40),
    location: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 },
    isDefault: !!a.isDefault
  }
}

function publicAddress(a) {
  return { _id: a._id, name: a.name, phone: a.phone, place: a.place, detail: a.detail || '', location: a.location, isDefault: !!a.isDefault }
}

function myAddresses(openid) {
  return safeList(col('cw_addresses').where({ _openid: openid }).orderBy('updatedAt', 'desc').limit(MAX_ADDRESSES))
}

// ---------- 订单 ----------

// 顾客看的订单：不带 openid
function formatOrder(o) {
  const out = Object.assign({}, o)
  delete out._openid
  out.statusText = STATUS_TEXT[o.status] || o.status
  out.modeText = MODES[o.mode] || o.mode
  return out
}

// 店员看的订单：技师只看得到待接的单和派给自己的单的地址、电话
function staffOrder(o, staff) {
  const out = formatOrder(o)
  if (!isAdmin(staff) && o.status !== 'pending' && o.techId !== staff._id) {
    out.address = null
    out.contactPhone = ''
  }
  return out
}

function payDeadline(order) {
  return new Date(order.createdAt).getTime() + PAY_MINUTES * 60000
}

function isOverdue(order) {
  return !!order.awaitingPay && order.status === 'pending' && order.payStatus === 'unpaid' && Date.now() >= payDeadline(order) + PAY_GRACE
}

async function orderOf(id, openid) {
  const where = { _id: String(id || '') }
  if (openid !== undefined) where._openid = openid
  return findOne('cw_orders', where)
}

// 退钱、退次卡。fee：超时取消要扣的钱；用次卡的单扣掉这 1 次当作扣费，现金部分全退
async function settleRefund(orderId, fee) {
  const order = await orderOf(orderId)
  if (!order || order.status !== 'cancelled') return
  let moneyFee = fee || 0
  if (order.cardId) {
    if (moneyFee > 0) {
      moneyFee = 0
    } else {
      await membership.returnCard({
        cardId: order.cardId,
        title: '预约取消退回 ' + order.serviceName,
        refType: 'order',
        refId: order._id,
        refNo: order.orderNo,
        guard: async () => {
          const res = await col('cw_orders').where({ _id: order._id, cardReturned: _.neq(true) }).update({ data: { cardReturned: true } })
          return res.stats.updated > 0
        }
      })
    }
  }
  if (order.payStatus !== 'paid' || !(order.payFee > 0)) return
  const back = Math.max(0, order.payFee - moneyFee)
  const mark = (data) => col('cw_orders').where({ _id: order._id, payStatus: 'paid' })
    .update({ data: Object.assign({ refundFee: back, refundedAt: db.serverDate(), updatedAt: db.serverDate() }, data) })
  const status = back === order.payFee ? 'refunded' : 'paid'
  if (!back) return
  if (order.payMethod === 'balance') {
    await ledger.refund(db, order._openid, back, { title: '预约取消退回 ' + order.serviceName, refType: 'carwash', refId: order._id, refNo: order.orderNo }, async () => {
      const res = await mark({ payStatus: status, refundStatus: 'done' })
      return res.stats.updated > 0
    })
  } else if (order.payMethod === 'wechat') {
    await pay.refund({ shop: SHOP, outTradeNo: order.payOutTradeNo || order.orderNo, outRefundNo: 'R' + order.orderNo, totalFee: order.payFee, refundFee: back })
    await mark({ payStatus: status, refundStatus: 'done' })
  } else {
    // 到店付的钱：店里线下退，这里只记一笔
    await mark({ payStatus: status, refundStatus: 'offline' })
  }
}

// 取消：先带条件把单子标成取消（同一单只会取消一次、只退一次），再退钱退卡
async function cancelAndRefund(order, { reason, fee, by, byName, statuses }) {
  const res = await col('cw_orders')
    .where({ _id: order._id, status: _.in(statuses || OPEN) })
    .update({ data: { status: 'cancelled', cancelReason: cleanText(reason, 40), cancelFee: fee || 0, cancelledBy: by || '', cancelledByName: byName || '', cancelledAt: db.serverDate(), updatedAt: db.serverDate() } })
  if (!res.stats.updated) return false
  await settleRefund(order._id, fee || 0)
  return true
}

// 微信支付成功：核对金额后标成已付；单子已经取消了（顾客付款途中取消、超时被取消），原路全退
async function markWechatPaid(order, paid) {
  if (!paid || paid.totalFee !== order.payFee) {
    if (paid) console.error('carwash pay amount mismatch', order.orderNo, paid.totalFee, order.payFee)
    return false
  }
  const res = await col('cw_orders')
    .where({ _id: order._id, payStatus: 'unpaid' })
    .update({ data: { payStatus: 'paid', payMethod: 'wechat', awaitingPay: false, transactionId: paid.transactionId, paidAt: db.serverDate(), updatedAt: db.serverDate() } })
  const now = await orderOf(order._id)
  if (res.stats.updated && now.status === 'cancelled') {
    await pay.refund({ shop: SHOP, outTradeNo: now.payOutTradeNo || now.orderNo, outRefundNo: 'R' + now.orderNo, totalFee: now.payFee })
    await col('cw_orders').doc(now._id).update({ data: { payStatus: 'refunded', refundFee: now.payFee, refundStatus: 'done', refundedAt: db.serverDate() } })
  }
  if (!res.stats.updated && now.payMethod === 'balance' && !now.dupRefunded) {
    // 刚好用余额付掉了，微信这笔原路退回
    await pay.refund({ shop: SHOP, outTradeNo: now.payOutTradeNo || now.orderNo, outRefundNo: 'RD' + now.orderNo, totalFee: paid.totalFee })
    await col('cw_orders').doc(now._id).update({ data: { dupRefunded: true, dupTransactionId: paid.transactionId } })
  }
  return true
}

// 超时没付的单：先向微信查一次，真付了就标成已付；没付就取消，退回用掉的次卡
async function expireOrder(order) {
  if (order.payOutTradeNo && (await markWechatPaid(order, await pay.queryPaid(order.payOutTradeNo, SHOP)))) return false
  return cancelAndRefund(order, { reason: '超时未付款', fee: 0, by: 'system', statuses: ['pending'] })
}

async function freshOrder(order) {
  if (!order || !isOverdue(order)) return order
  await expireOrder(order)
  return orderOf(order._id)
}

// 每个时段已经约了几单：{ 'start:mode': n }
async function takenSlots(days) {
  if (!days.length) return {}
  let list = []
  try {
    list = await fetchAll(col('cw_orders').where({ slotDay: _.in(days), status: _.in(OPEN) }).field({ slotStart: true, mode: true }), 5000)
  } catch (e) {
    if (!isMissingCollection(e)) throw e
  }
  const taken = {}
  list.forEach((o) => {
    const k = o.slotStart + ':' + o.mode
    taken[k] = (taken[k] || 0) + 1
  })
  return taken
}

async function onPayNotify({ outTradeNo }) {
  if (typeof outTradeNo !== 'string') return
  if (outTradeNo.indexOf('CW') === 0) {
    const order = await findOne('cw_orders', { orderNo: outTradeNo })
    if (order && order.payStatus === 'unpaid') await markWechatPaid(order, await pay.queryPaid(outTradeNo, SHOP))
    else if (order && order.payMethod === 'balance' && order.payOutTradeNo) await markWechatPaid(order, await pay.queryPaid(outTradeNo, SHOP))
    return
  }
  await membership.onPayNotify({ outTradeNo })
}

// 服务器每分钟跑一次：取消超时没付款的单；技师点完成后顾客一直没确认的，到时间自动算完成
async function runTimers() {
  let count = 0
  const cutoff = new Date(Date.now() - PAY_MINUTES * 60000 - PAY_GRACE)
  const overdue = await safeList(col('cw_orders').where({ awaitingPay: true, status: 'pending', payStatus: 'unpaid', createdAt: _.lt(cutoff) }).limit(50))
  for (const order of overdue) {
    if (await expireOrder(order)) count++
  }
  const s = await shop.readSettings(db)
  if (s.autoConfirmHours) {
    const before = new Date(Date.now() - s.autoConfirmHours * 3600 * 1000)
    const res = await col('cw_orders').where({ status: 'done', doneAt: _.lt(before) })
      .update({ data: { status: 'finished', finishedBy: 'auto', finishedAt: db.serverDate(), updatedAt: db.serverDate() } })
    count += res.stats.updated
  }
  return count
}

function randomCode() {
  return String(100000 + (crypto.randomBytes(4).readUInt32BE(0) % 900000))
}

const handlers = {
  // ---------- 顾客端 ----------

  // 首页：店铺信息、能不能约、服务项目、会员
  async getHome(event, openid) {
    const [state, services, ms, member, cards] = await Promise.all([
      loadState(),
      enabledServices(),
      membership.readMemberSettings(),
      ledger.findMember(db, openid),
      openid ? membership.usableCards(openid) : []
    ])
    const s = state.settings
    return {
      shop: publicShop(s),
      bookingOpen: state.open,
      modes: Object.keys(MODES).filter((m) => shop.capacityOf(s, m) > 0),
      services: services.map(publicService),
      member: {
        enabled: ms.enabled,
        balance: member ? member.balance || 0 : 0,
        isMember: wallet.isMember(member),
        cards: cards.length
      }
    }
  },

  // 预约页：这个项目能选的方式、时段（带剩余名额）、地址、能用的次卡、余额、付款方式、取消规则
  async getBookingInfo({ serviceId }, openid) {
    const state = await loadState()
    if (!state.open) throw new BizError('店里暂时没开放预约', 'BOOKING_CLOSED')
    const s = state.settings
    const service = await usableService(serviceId)
    const modes = modesFor(service, s)
    const days = shop.slotDays(s)
    const [taken, addresses, cards, member] = await Promise.all([
      takenSlots(days.map((d) => d.day)),
      myAddresses(openid),
      membership.usableCards(openid, service._id),
      ledger.findMember(db, openid)
    ])
    const left = (start, mode) => Math.max(0, shop.capacityOf(s, mode) - (taken[start + ':' + mode] || 0))
    return {
      service: publicService(service),
      modes,
      days: days.map((d) => ({
        day: d.day,
        label: d.label,
        slots: d.slots.map((x) => ({ start: x.start, label: x.label, left: { store: left(x.start, 'store'), door: left(x.start, 'door') } }))
      })),
      addresses: addresses.map(publicAddress),
      cards: cards.map((c) => membership.publicCard(c)),
      wallet: { enabled: state.ways.member, balance: member ? member.balance || 0 : 0, isMember: wallet.isMember(member) },
      pay: { wechat: state.ways.wechat, later: s.payLater },
      unitPrice: wallet.isMember(member) && Number.isInteger(service.memberPrice) ? service.memberPrice : service.price,
      door: modes.indexOf('door') !== -1 ? { radiusKm: s.doorRadiusKm, fee: s.doorFee, outOfRange: s.outOfRange, outOfRangeFee: s.outOfRangeFee } : null,
      policy: shop.policyText(s),
      notice: s.notice
    }
  },

  // 算价：上门的按地址算距离和上门费；用次卡的抵掉项目价
  async quote({ serviceId, mode, addressId, cardId }, openid) {
    const s = await shop.readSettings(db)
    const service = await usableService(serviceId)
    if (modesFor(service, s).indexOf(mode) === -1) throw new BizError('这个项目现在不能' + (MODES[mode] || '这样') + '做')
    let place = null
    if (mode === 'door') {
      const a = await findOne('cw_addresses', { _id: String(addressId || ''), _openid: openid })
      if (!a) throw new BizError('请选上门地址', 'ADDRESS_NEEDED')
      place = a.location
    }
    const price = priceFor(service, mode, s, await ledger.findMember(db, openid), place)
    let cardCover = 0
    if (cardId) {
      const card = (await membership.usableCards(openid, service._id)).find((c) => c._id === cardId)
      if (!card) throw new BizError('这张次卡用不了了', 'CARD_GONE')
      cardCover = price.unitPrice
    }
    return Object.assign(price, { cardCover, payFee: price.totalFee - cardCover })
  },

  // 下单。payBy：wechat（下单后调 payOrder 拉起支付，15 分钟内付）、balance（下单时扣余额）、later（到店或服务后付）；
  // 用次卡（cardId）把项目价抵掉，剩下的钱（上门费等）按 payBy 付；全抵掉了就不用付
  async createOrder({ serviceId, mode, slotStart, addressId, cardId, payBy, plate, carModel, contactName, contactPhone, remark }, openid) {
    const state = await loadState()
    if (!state.open) throw new BizError('店里暂时没开放预约', 'BOOKING_CLOSED')
    const s = state.settings
    const service = await usableService(serviceId)
    if (modesFor(service, s).indexOf(mode) === -1) throw new BizError('这个项目现在不能' + (MODES[mode] || '这样') + '做')
    const slot = shop.findSlot(s, Number(slotStart))
    if (!slot) throw new BizError('这个时间约不了了，请重新选一个时间', 'SLOT_GONE')

    let address = null
    let phone = String(contactPhone || '').trim()
    let name = cleanText(contactName, 10)
    if (mode === 'door') {
      const a = await findOne('cw_addresses', { _id: String(addressId || ''), _openid: openid })
      if (!a) throw new BizError('请选上门地址', 'ADDRESS_NEEDED')
      address = publicAddress(a)
      phone = a.phone
      name = a.name
    } else if (phone && !PHONE_RE.test(phone)) {
      throw new BizError('联系电话格式不对')
    }

    const member = await ledger.findMember(db, openid)
    const price = priceFor(service, mode, s, member, address && address.location)
    let card = null
    if (cardId) {
      card = (await membership.usableCards(openid, service._id)).find((c) => c._id === cardId)
      if (!card) throw new BizError('这张次卡用不了了，请重新选择', 'CARD_GONE')
    }
    const cardCover = card ? price.unitPrice : 0
    const payFee = price.totalFee - cardCover
    if (payFee > 0) {
      if (PAY_BY.indexOf(payBy) === -1) throw new BizError('请选择付款方式')
      if (payBy === 'wechat' && !state.ways.wechat) throw new BizError('店里还没开通微信支付，换个付款方式', 'PAY_DISABLED')
      if (payBy === 'balance' && !state.ways.member) throw new BizError('店里暂时没开放余额付款', 'MEMBER_DISABLED')
      if (payBy === 'balance' && !(member && member.balance >= payFee)) throw new BizError('余额不够了，换个付款方式，或者先充值', 'BALANCE_LOW')
      if (payBy === 'later' && !s.payLater) throw new BizError('店里不支持到店付款，换个付款方式', 'PAY_LATER_DISABLED')
    }

    const orderNo = makeOrderNo()
    const order = {
      _openid: openid,
      orderNo,
      memberNo: member ? member.memberNo : '',
      serviceId: service._id,
      serviceName: service.name,
      mode,
      slotStart: slot.start,
      slotEnd: slot.end,
      slotDay: slot.day,
      slotLabel: slot.dayLabel + ' ' + slot.label,
      address,
      contactName: name,
      contactPhone: phone,
      plate: cleanText(plate, 10).toUpperCase(),
      carModel: cleanText(carModel, 20),
      remark: cleanText(remark, 60),
      servicePrice: price.servicePrice,
      unitPrice: price.unitPrice,
      memberPriced: price.memberPriced,
      distanceKm: price.distanceKm,
      doorFee: price.doorFee,
      extraFee: price.extraFee,
      totalFee: price.totalFee,
      cardId: card ? card._id : '',
      cardName: card ? card.name : '',
      cardCover,
      payFee,
      payStatus: payFee === 0 ? 'paid' : 'unpaid',
      payMethod: payFee === 0 ? 'card' : (payBy === 'wechat' ? '' : payBy), // 微信付款后改成 wechat
      // 在线付款的单要先付，付完技师才看得到
      awaitingPay: payFee > 0 && payBy === 'wechat',
      status: 'pending',
      techId: '',
      techName: '',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    // 防超约：数这个时段已经约了几单和写入新单放在同一个队列里，同时下单也不会超出名额
    const added = await db.runTransaction(async () => {
      const taken = (await col('cw_orders').where({ slotStart: slot.start, mode, status: _.in(OPEN) }).count()).total
      if (taken >= shop.capacityOf(s, mode)) throw new BizError('这个时段约满了，换一个时间吧', 'SLOT_FULL')
      return col('cw_orders').add({ data: order })
    })
    const saved = Object.assign({ _id: added._id }, order)
    const undo = async (reason) => {
      await col('cw_orders').where({ _id: added._id, status: 'pending' })
        .update({ data: { status: 'cancelled', cancelReason: reason, cancelledBy: 'system', cancelledAt: db.serverDate(), updatedAt: db.serverDate() } })
    }
    if (card) {
      try {
        await membership.useCard({ cardId: card._id, openid, serviceId: service._id, title: '预约 ' + service.name + ' ' + order.slotLabel, refType: 'order', refId: added._id, refNo: orderNo })
      } catch (e) {
        await undo('次卡扣次没成功')
        throw e
      }
    }
    if (payFee > 0 && payBy === 'balance') {
      try {
        await ledger.pay(db, openid, payFee, { title: '预约 ' + service.name + ' ' + order.slotLabel, refType: 'carwash', refId: added._id, refNo: orderNo })
      } catch (e) {
        await cancelAndRefund(saved, { reason: '余额扣款没成功', fee: 0, by: 'system' })
        throw e
      }
      await col('cw_orders').doc(added._id).update({ data: { payStatus: 'paid', paidAt: db.serverDate() } })
    }
    return { id: added._id, orderNo, payFee, awaitingPay: order.awaitingPay }
  },

  // 顾客用微信支付：返回 wx.requestPayment 要的参数
  async payOrder({ id }, openid) {
    const order = await freshOrder(await orderOf(id, openid))
    if (!order) throw new BizError('订单不存在')
    if (order.status === 'cancelled') throw new BizError('订单已经取消了')
    if (order.payStatus !== 'unpaid') throw new BizError('这单已经付过了')
    if (!(await membership.payWays()).wechat) throw new BizError('店里还没开通微信支付', 'PAY_DISABLED')
    let timeExpire
    if (order.awaitingPay) {
      const deadline = payDeadline(order)
      if (Date.now() >= deadline) throw new BizError('超过 ' + PAY_MINUTES + ' 分钟没付款，这单会自动取消，请重新预约', 'PAY_EXPIRED')
      timeExpire = Math.max(deadline, Date.now() + 70 * 1000)
    }
    const payment = await pay.unifiedOrder({ payEnabled: true }, {
      body: '洗车-' + order.serviceName,
      outTradeNo: order.orderNo,
      totalFee: order.payFee,
      openid,
      notify: 'carwash',
      shop: SHOP,
      timeExpire
    })
    await col('cw_orders').doc(order._id).update({ data: { payOutTradeNo: order.orderNo, updatedAt: db.serverDate() } })
    return { payment }
  },

  // 顾客用余额付一个还没付的单
  async payWithBalance({ id }, openid) {
    const order = await freshOrder(await orderOf(id, openid))
    if (!order) throw new BizError('订单不存在')
    if (order.status === 'cancelled') throw new BizError('订单已经取消了')
    if (order.payStatus !== 'unpaid') throw new BizError('这单已经付过了')
    if (!(await membership.payWays()).member) throw new BizError('店里暂时没开放余额付款', 'MEMBER_DISABLED')
    // 拉起过微信支付的，先查一下是不是其实已经付了
    if (order.payOutTradeNo && (await markWechatPaid(order, await pay.queryPaid(order.payOutTradeNo, SHOP)))) return { payStatus: 'paid' }
    const log = { refType: 'carwash', refId: order._id, refNo: order.orderNo }
    await ledger.pay(db, openid, order.payFee, Object.assign({ title: '预约 ' + order.serviceName + ' ' + order.slotLabel }, log))
    const res = await col('cw_orders')
      .where({ _id: order._id, payStatus: 'unpaid', status: _.neq('cancelled') })
      .update({ data: { payStatus: 'paid', payMethod: 'balance', awaitingPay: false, paidAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) {
      await ledger.refund(db, openid, order.payFee, Object.assign({ title: '订单状态变了，退回' }, log))
      throw new BizError('订单状态刚刚变了，钱已经退回余额，请刷新看看')
    }
    return { payStatus: 'paid' }
  },

  // 付完款后顾客端调一下，向微信查单确认
  async confirmPay({ id }, openid) {
    const order = await orderOf(id, openid)
    if (!order) throw new BizError('订单不存在')
    if (order.payStatus === 'unpaid' && order.payOutTradeNo) {
      if (await markWechatPaid(order, await pay.queryPaid(order.payOutTradeNo, SHOP))) return { payStatus: 'paid' }
    }
    return { payStatus: order.payStatus }
  },

  async getOrder({ id }, openid) {
    const order = await freshOrder(await orderOf(id, openid))
    if (!order) throw new BizError('订单不存在')
    const s = await shop.readSettings(db)
    const out = formatOrder(order)
    out.policy = shop.policyText(s)
    out.shop = publicShop(s)
    // 能不能自己取消、取消要扣多少（和 cancelOrder 的算法一样：没付钱也没用次卡的随时能取消）
    out.cancel = null
    if (CUSTOMER_CANCEL.indexOf(order.status) !== -1) {
      try {
        const charge = order.payStatus === 'paid' || order.cardId ? shop.cancelCharge(s, order) : { late: false, fee: 0 }
        out.cancel = Object.assign({ allowed: true }, charge)
      } catch (e) {
        if (!(e instanceof BizError)) throw e
        out.cancel = { allowed: false, reason: e.message }
      }
    }
    if (order.payStatus === 'unpaid' && order.status !== 'cancelled') {
      const [ways, member] = await Promise.all([membership.payWays(), ledger.findMember(db, openid)])
      out.payWays = { wechat: ways.wechat, balance: ways.member, balanceLeft: member ? member.balance || 0 : 0 }
      if (order.awaitingPay) out.payDeadline = payDeadline(order)
    }
    return out
  },

  async myOrders({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const list = await safeList(col('cw_orders').where({ _openid: openid }).orderBy('createdAt', 'desc').skip(p * size).limit(size))
    const orders = []
    for (const o of list) orders.push(formatOrder(await freshOrder(o)))
    return { orders, hasMore: list.length === size }
  },

  // 顾客取消：技师出发前可以取消；离开始太近的按店里的规则（不能取消 / 扣钱 / 照常退）
  async cancelOrder({ id }, openid) {
    const order = await orderOf(id, openid)
    if (!order) throw new BizError('订单不存在')
    if (CUSTOMER_CANCEL.indexOf(order.status) === -1) {
      throw new BizError(order.status === 'cancelled' ? '订单已经取消了' : '技师已经出发或在服务了，不能在线取消，请联系店里', 'CANCEL_NOT_ALLOWED')
    }
    const s = await shop.readSettings(db)
    // 没付钱的单（等付款、到店付）随时能取消，不扣钱；用了次卡的照规则走
    let charge = { late: false, fee: 0 }
    if (order.payStatus === 'paid' || order.cardId) charge = shop.cancelCharge(s, order)
    const ok = await cancelAndRefund(order, { reason: charge.late ? '顾客取消（超时）' : '顾客取消', fee: charge.fee, by: openid, statuses: CUSTOMER_CANCEL })
    if (!ok) throw new BizError('订单状态刚刚变了，请刷新看看')
    return { fee: charge.fee }
  },

  // 顾客确认服务完成
  async confirmDone({ id }, openid) {
    const order = await orderOf(id, openid)
    if (!order) throw new BizError('订单不存在')
    const res = await col('cw_orders').where({ _id: order._id, status: 'done' })
      .update({ data: { status: 'finished', finishedBy: 'customer', finishedAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('技师还没点完成，或者已经确认过了')
    return true
  },

  // ---------- 顾客的地址簿 ----------

  async listAddresses(event, openid) {
    return (await myAddresses(openid)).map(publicAddress)
  },

  async saveAddress({ address }, openid) {
    const a = address || {}
    const data = cleanAddress(a)
    data.updatedAt = db.serverDate()
    let id = a._id ? String(a._id) : ''
    if (id) {
      const res = await col('cw_addresses').where({ _id: id, _openid: openid }).update({ data })
      if (!res.stats.updated) throw new BizError('这个地址不存在了')
    } else {
      const count = (await col('cw_addresses').where({ _openid: openid }).count()).total
      if (count >= MAX_ADDRESSES) throw new BizError('地址最多存 ' + MAX_ADDRESSES + ' 个，先删掉一些不用的')
      if (!count) data.isDefault = true
      data._openid = openid
      data.createdAt = db.serverDate()
      id = (await col('cw_addresses').add({ data }))._id
    }
    // 只有一个默认地址
    if (data.isDefault) await col('cw_addresses').where({ _openid: openid, _id: _.neq(id), isDefault: true }).update({ data: { isDefault: false } })
    return { id }
  },

  async deleteAddress({ id }, openid) {
    await col('cw_addresses').where({ _id: String(id || ''), _openid: openid }).remove()
    return true
  },

  // ---------- 店员（店长、技师） ----------

  // scope：todo 待接的单；mine 派给我的；all 当天全部（只有店长能看）
  async staffOrders({ day, scope }, openid) {
    const staff = await requireStaff(openid)
    const d = DAY_RE.test(day || '') ? day : cnDay()
    const sc = ['todo', 'mine', 'all'].indexOf(scope) === -1 ? 'todo' : scope
    if (sc === 'all' && !isAdmin(staff)) throw new BizError('只有店长能看全部的单', 'FORBIDDEN')
    const where = { slotDay: d }
    if (sc === 'todo') where.status = 'pending'
    if (sc === 'mine') {
      where.techId = openid
      where.status = _.in(['confirmed', 'departed', 'serving', 'done'])
    }
    const list = (await safeList(col('cw_orders').where(where).orderBy('slotStart', 'asc').limit(500)))
      .filter((o) => !o.awaitingPay)
    return { day: d, orders: list.map((o) => staffOrder(o, staff)) }
  },

  async staffGetOrder({ id }, openid) {
    const staff = await requireStaff(openid)
    const order = await orderOf(id)
    if (!order || order.awaitingPay) throw new BizError('订单不存在')
    return staffOrder(order, staff)
  },

  // 技师接单（待接单 → 已接单，派给自己）；两个人同时点，只有一个能接到
  async acceptOrder({ id }, openid) {
    const staff = await requireStaff(openid)
    const res = await col('cw_orders')
      .where({ _id: String(id || ''), status: 'pending', awaitingPay: false })
      .update({ data: { status: 'confirmed', techId: openid, techName: staffName(staff), confirmedAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('这单已经被接走了，或者已经取消了', 'ORDER_TAKEN')
    return true
  },

  // 店长派单 / 改派
  async assignOrder({ id, techId }, openid) {
    await requireAdmin(openid)
    const tech = await getStaff(db, String(techId || ''))
    if (!tech || CARWASH_STAFF.indexOf(tech.role) === -1) throw new BizError('请选择一位技师')
    const res = await col('cw_orders')
      .where({ _id: String(id || ''), status: _.in(['pending', 'confirmed']), awaitingPay: false })
      .update({ data: { status: 'confirmed', techId: tech._id, techName: staffName(tech), confirmedAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('这单已经开始了或者取消了，不能再派')
    return true
  },

  // 技师推进：已接单 → 出发（上门）→ 开始服务 → 完成。只有接单的技师或店长能点
  async advanceOrder({ id, status }, openid) {
    const staff = await requireStaff(openid)
    const order = await orderOf(id)
    if (!order) throw new BizError('订单不存在')
    if (order.techId !== openid && !isAdmin(staff)) throw new BizError('这单不是派给你的', 'FORBIDDEN')
    const next = NEXT[order.status] || []
    if (next.indexOf(status) === -1 || (status === 'departed' && order.mode !== 'door')) {
      throw new BizError('订单现在是「' + (STATUS_TEXT[order.status] || order.status) + '」，不能改成这个状态', 'BAD_STATUS')
    }
    const res = await col('cw_orders').where({ _id: order._id, status: order.status })
      .update({ data: { status, [TIME_FIELD[status]]: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('订单状态刚刚变了，请刷新')
    return true
  },

  // 到店付款的单：技师收到钱（现金、收款码）后登记
  async collectPay({ id }, openid) {
    const staff = await requireStaff(openid)
    const order = await orderOf(id)
    if (!order) throw new BizError('订单不存在')
    if (order.techId !== openid && !isAdmin(staff)) throw new BizError('这单不是派给你的', 'FORBIDDEN')
    const res = await col('cw_orders')
      .where({ _id: order._id, payStatus: 'unpaid', awaitingPay: false, status: _.neq('cancelled') })
      .update({ data: { payStatus: 'paid', payMethod: 'counter', collectedBy: openid, collectedByName: staffName(staff), paidAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('这单已经收过钱了，或者已经取消了')
    return true
  },

  // 店长取消（顾客电话里说不来了、下雨等）：全额退
  async staffCancelOrder({ id, reason }, openid) {
    const staff = await requireAdmin(openid)
    const why = cleanText(reason, 40)
    if (!why) throw new BizError('请写上取消原因')
    const order = await orderOf(id)
    if (!order) throw new BizError('订单不存在')
    const ok = await cancelAndRefund(order, { reason: why, fee: 0, by: openid, byName: staffName(staff) })
    if (!ok) throw new BizError('这单已经完成或者取消了')
    return true
  },

  // ---------- 后台：技师（店长） ----------

  async listTechs(event, openid) {
    await requireAdmin(openid)
    const list = await safeList(col('staff').where({ role: _.in(CARWASH_STAFF) }).orderBy('createdAt', 'asc').limit(100))
    return list.map((s) => ({ id: s._id, name: s.name, role: s.role, roleName: ROLES[s.role], isMe: s._id === openid }))
  },

  // 店长生成技师邀请码；店主还能邀请洗车店长。技师在洗车小程序「我的 → 员工绑定」填码
  async createTechInvite({ role }, openid) {
    const staff = await requireAdmin(openid)
    const r = role || 'technician'
    if (r !== 'technician' && !(r === 'carwash_manager' && staff.role === 'owner')) throw new BizError('只能邀请洗车技师')
    let code = randomCode()
    for (let i = 0; i < 5; i++) {
      const dup = await col('staff_invites').where({ code, used: false, expiresAt: _.gt(Date.now()) }).count()
      if (!dup.total) break
      code = randomCode()
    }
    const expiresAt = Date.now() + INVITE_TTL
    await col('staff_invites').add({ data: { code, role: r, used: false, expiresAt, createdBy: openid, createdAt: db.serverDate() } })
    return { code, role: r, roleName: ROLES[r], expiresAt }
  },

  async removeTech({ id }, openid) {
    const staff = await requireAdmin(openid)
    const target = await getStaff(db, String(id || ''))
    if (!target) throw new BizError('找不到这位员工')
    if (target._id === openid) throw new BizError('不能移除自己')
    if (target.role !== 'technician' && !(target.role === 'carwash_manager' && staff.role === 'owner')) throw new BizError('只能移除洗车技师')
    await col('staff').doc(target._id).remove()
    await col('web_sessions').where({ staffId: target._id }).remove()
    return true
  },

  // ---------- 后台：洗车店设置（店长） ----------

  async getSettings(event, openid) {
    await requireAdmin(openid)
    const state = await loadState()
    return {
      settings: state.settings,
      problems: state.problems,
      open: state.open,
      payReady: cloud.payOf(SHOP).ready(),
      mchId: cloud.payOf(SHOP).mchId || '',
      memberEnabled: state.ways.member
    }
  },

  async saveSettings({ settings }, openid) {
    await requireAdmin(openid)
    const data = shop.cleanSettings(settings)
    if (data.payEnabled && !cloud.payOf(SHOP).ready()) {
      throw new BizError('服务器上还没配置洗车的微信支付（商户号、API 证书和 APIv3 密钥），配好后再打开')
    }
    if (data.bookingEnabled) {
      const ways = await membership.payWays()
      const missing = shop.problems(data, { wechat: data.payEnabled, member: ways.member })
      if (missing.length) throw new BizError('开放预约前还要填：' + missing.join('、'), 'SETTINGS_INCOMPLETE')
    }
    data.updatedBy = openid
    data.updatedAt = db.serverDate()
    await col('settings').doc(shop.SETTINGS_ID).set({ data })
    return handlers.getSettings({}, openid)
  },

  // ---------- 后台：服务项目和价格（店长） ----------

  async adminListServices(event, openid) {
    await requireAdmin(openid)
    return safeList(col('cw_services').orderBy('sort', 'asc').limit(MAX_SERVICES))
  },

  async saveService({ service }, openid) {
    await requireAdmin(openid)
    const s = service || {}
    const data = cleanService(s)
    data.updatedAt = db.serverDate()
    if (s._id) {
      const res = await col('cw_services').where({ _id: String(s._id) }).update({ data })
      if (!res.stats.updated) throw new BizError('这个项目不存在了')
      return { id: String(s._id) }
    }
    const count = (await col('cw_services').count()).total
    if (count >= MAX_SERVICES) throw new BizError('服务项目最多 ' + MAX_SERVICES + ' 个')
    data.sort = s.sort === undefined ? count : toSort(s.sort)
    data.createdAt = db.serverDate()
    const added = await col('cw_services').add({ data })
    return { id: added._id }
  },

  async setServiceFlags({ id, enabled }, openid) {
    await requireAdmin(openid)
    if (typeof enabled !== 'boolean') throw new BizError('参数不对')
    const res = await col('cw_services').where({ _id: String(id || '') }).update({ data: { enabled, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('这个项目不存在了')
    return true
  },

  async sortServices({ ids }, openid) {
    await requireAdmin(openid)
    if (!Array.isArray(ids) || ids.length > MAX_SERVICES) throw new BizError('排序数据不对')
    await Promise.all(ids.map((id, index) => col('cw_services').where({ _id: String(id) }).update({ data: { sort: index } })))
    return true
  },

  // 删掉项目不影响已经约了的单（单子里存着项目名称和价格）
  async deleteService({ id }, openid) {
    await requireAdmin(openid)
    await col('cw_services').where({ _id: String(id || '') }).remove()
    return true
  },

  // ---------- 后台：预约订单和日历（店长） ----------

  // 某一天的单（不含还没付款的在线单）；status 不传是全部
  async adminOrders({ day, status }, openid) {
    await requireAdmin(openid)
    const d = DAY_RE.test(day || '') ? day : cnDay()
    const list = (await safeList(col('cw_orders').where({ slotDay: d }).orderBy('slotStart', 'asc').limit(1000))).filter((o) => !o.awaitingPay)
    const counts = {}
    list.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1 })
    const shown = STATUS_TEXT[status] ? list.filter((o) => o.status === status) : list
    return { day: d, counts, orders: shown.map(formatOrder) }
  },

  // 日历：从 from 开始 days 天（最多 31 天），每天约了多少（没取消的）、还有几单没人接、名额一共多少
  async calendar({ from, days }, openid) {
    await requireAdmin(openid)
    const start = DAY_RE.test(from || '') ? from : cnDay()
    const n = Math.min(31, Math.max(1, Math.floor(Number(days) || 14)))
    const list = dayRange(start, wallet.addDays(start, n - 1))
    const s = await shop.readSettings(db)
    let orders = []
    try {
      orders = await fetchAll(col('cw_orders').where({ slotDay: _.in(list), status: _.neq('cancelled') }).field({ slotDay: true, mode: true, status: true, awaitingPay: true }), 10000)
    } catch (e) {
      if (!isMissingCollection(e)) throw e
    }
    // 一天有几段
    const perDay = s.hours && s.slotMinutes ? Math.floor((toMinutes(s.hours.close) - toMinutes(s.hours.open)) / s.slotMinutes) : 0
    const rows = {}
    list.forEach((d) => {
      rows[d] = { day: d, store: 0, door: 0, pending: 0, capacity: { store: perDay * (s.storeCapacity || 0), door: perDay * (s.doorCapacity || 0) } }
    })
    orders.forEach((o) => {
      const r = rows[o.slotDay]
      if (!r) return
      r[o.mode]++
      if (o.status === 'pending' && !o.awaitingPay) r.pending++
    })
    return { days: list.map((d) => rows[d]) }
  },

  // 洗车每日汇总：按服务日期算单数、各种付款方式收了多少
  async daySummary({ from, to }, openid) {
    await requireAdmin(openid)
    const days = dayRange(from, to)
    let orders = []
    try {
      orders = await fetchAll(col('cw_orders').where({ slotDay: _.in(days) }))
    } catch (e) {
      if (!isMissingCollection(e)) throw e
    }
    const rows = {}
    days.forEach((d) => {
      rows[d] = { day: d, orders: 0, finished: 0, cancelled: 0, store: 0, door: 0, totalFee: 0, wechatFee: 0, balanceFee: 0, counterFee: 0, unpaidFee: 0, cardUses: 0, refundFee: 0, cancelFee: 0 }
    })
    orders.forEach((o) => {
      const r = rows[o.slotDay]
      if (!r || (o.awaitingPay && o.status !== 'cancelled')) return
      if (o.status === 'cancelled') {
        // 没付过钱就取消的单不算
        if (o.payStatus !== 'unpaid' || o.cardId) r.cancelled++
        if (o.refundFee) r.refundFee += o.refundFee
        if (o.payStatus === 'paid') r.cancelFee += o.payFee - (o.refundFee || 0)
        return
      }
      r.orders++
      r[o.mode]++
      if (o.status === 'finished') r.finished++
      r.totalFee += o.totalFee
      if (o.cardId) r.cardUses++
      if (o.payStatus === 'paid') {
        if (o.payMethod === 'wechat') r.wechatFee += o.payFee
        else if (o.payMethod === 'balance') r.balanceFee += o.payFee
        else if (o.payMethod === 'counter') r.counterFee += o.payFee
      } else r.unpaidFee += o.payFee
    })
    const list = days.map((d) => rows[d])
    const totals = list.reduce((acc, r) => {
      Object.keys(r).forEach((k) => { if (k !== 'day') acc[k] = (acc[k] || 0) + r[k] })
      return acc
    }, {})
    return { days: list, totals }
  }
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

// 会员、送券、核销的操作也走 /api/carwash；名字不能和上面的重复
const linkHandlers = link.createHandlers(db, { requireAdmin })
const redeemHandlers = redeem.createHandlers({ requireStaff })
;[membership.handlers, linkHandlers, redeemHandlers].forEach((group) => {
  Object.keys(group).forEach((k) => {
    if (handlers[k]) throw new Error('duplicate carwash action ' + k)
    handlers[k] = group[k]
  })
})

exports.main = createMain(cloud, handlers)
exports.onPayNotify = onPayNotify
exports.runTimers = runTimers
exports.STATUS_TEXT = STATUS_TEXT
