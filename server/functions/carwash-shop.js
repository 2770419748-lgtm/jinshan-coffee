// 洗车店的设置（settings 集合里 _id 为 carwash 的那条）：店铺信息、预约时段和容量、上门范围和费用、取消规则、付款方式。
// 这些数都由店长在后台填，代码里不给默认值；没填齐之前预约不开放，后台会列出还差哪几项。
// 预约能选的时段、上门距离和费用、取消时要不要扣钱，也在这里算。
const { BizError, isMissingCollection, cleanText, cnDay } = require('./base')

const SETTINGS_ID = 'carwash'
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const CN_OFFSET = 8 * 3600 * 1000
const DAY_MS = 24 * 3600 * 1000
const MAX_FEE = 1000000 // 1 万元
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const OUT_OF_RANGE = ['reject', 'fee']
const LATE_CANCEL = ['deny', 'fee', 'free']

// 数字类设置：[最小, 最大]；没填是 null
const NUMBERS = {
  slotMinutes: [10, 480],
  storeCapacity: [0, 99],
  doorCapacity: [0, 99],
  bookDays: [1, 60],
  leadMinutes: [0, 10080],
  doorFee: [0, MAX_FEE],
  outOfRangeFee: [0, MAX_FEE],
  freeCancelMinutes: [0, 10080],
  lateCancelFee: [0, MAX_FEE],
  autoConfirmHours: [1, 720]
}

async function readRaw(db) {
  try {
    const res = await db.collection('settings').where({ _id: SETTINGS_ID }).limit(1).get()
    return res.data[0] || {}
  } catch (e) {
    if (isMissingCollection(e)) return {}
    throw e
  }
}

function minutesOf(hhmm) {
  const m = HHMM_RE.exec(hhmm || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function normalize(s) {
  const out = {
    shopName: s.shopName || '',
    address: s.address || '',
    phone: s.phone || '',
    location: s.location && Number.isFinite(s.location.lat) && Number.isFinite(s.location.lng) ? { lat: s.location.lat, lng: s.location.lng } : null,
    notice: s.notice || '',
    bookingEnabled: !!s.bookingEnabled,
    payEnabled: !!s.payEnabled,
    payLater: !!s.payLater,
    hours: s.hours && minutesOf(s.hours.open) !== null && minutesOf(s.hours.close) !== null ? { open: s.hours.open, close: s.hours.close } : null,
    doorRadiusKm: Number.isFinite(s.doorRadiusKm) ? s.doorRadiusKm : null,
    outOfRange: OUT_OF_RANGE.indexOf(s.outOfRange) !== -1 ? s.outOfRange : null,
    lateCancel: LATE_CANCEL.indexOf(s.lateCancel) !== -1 ? s.lateCancel : null
  }
  Object.keys(NUMBERS).forEach((k) => { out[k] = intOrNull(s[k]) })
  return out
}

async function readSettings(db) {
  return normalize(await readRaw(db))
}

// 后台填的数字：空着是 null，填了就要在范围里
function numberField(value, key, label) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  const [min, max] = NUMBERS[key]
  if (!Number.isInteger(n) || n < min || n > max) throw new BizError(label + '请填 ' + min + ' 到 ' + max + ' 的整数')
  return n
}

function feeField(value, label) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > MAX_FEE) throw new BizError(label + '不对')
  return n
}

// 后台保存：检查格式，返回要存的内容（不检查填没填齐，那个看 problems）
function cleanSettings(input) {
  const s = input || {}
  let hours = null
  if (s.hours && (s.hours.open || s.hours.close)) {
    const open = minutesOf(s.hours.open)
    const close = minutesOf(s.hours.close)
    if (open === null || close === null) throw new BizError('营业时间格式不对，例如 09:00')
    if (close <= open) throw new BizError('打烊时间要晚于开门时间')
    hours = { open: s.hours.open, close: s.hours.close }
  }
  let location = null
  if (s.location && (s.location.lat !== '' && s.location.lat !== undefined && s.location.lat !== null)) {
    const lat = Number(s.location.lat)
    const lng = Number(s.location.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new BizError('店的位置（经纬度）不对')
    location = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }
  }
  let doorRadiusKm = null
  if (s.doorRadiusKm !== undefined && s.doorRadiusKm !== null && s.doorRadiusKm !== '') {
    doorRadiusKm = Number(s.doorRadiusKm)
    if (!Number.isFinite(doorRadiusKm) || doorRadiusKm <= 0 || doorRadiusKm > 200) throw new BizError('服务半径请填 0.1 到 200 公里')
    doorRadiusKm = Math.round(doorRadiusKm * 10) / 10
  }
  const pick = (list, value, label) => {
    if (value === undefined || value === null || value === '') return null
    if (list.indexOf(value) === -1) throw new BizError(label + '选项不对')
    return value
  }
  return {
    shopName: cleanText(s.shopName, 20),
    address: cleanText(s.address, 60),
    phone: cleanText(s.phone, 20),
    location,
    notice: cleanText(s.notice, 300),
    bookingEnabled: !!s.bookingEnabled,
    payEnabled: !!s.payEnabled,
    payLater: !!s.payLater,
    hours,
    slotMinutes: numberField(s.slotMinutes, 'slotMinutes', '每段时长（分钟）'),
    storeCapacity: numberField(s.storeCapacity, 'storeCapacity', '到店每段能接几单'),
    doorCapacity: numberField(s.doorCapacity, 'doorCapacity', '上门每段能接几单'),
    bookDays: numberField(s.bookDays, 'bookDays', '能约几天内'),
    leadMinutes: numberField(s.leadMinutes, 'leadMinutes', '至少提前多少分钟'),
    doorRadiusKm,
    doorFee: feeField(s.doorFee, '上门费'),
    outOfRange: pick(OUT_OF_RANGE, s.outOfRange, '超出范围'),
    outOfRangeFee: feeField(s.outOfRangeFee, '超出范围的加价'),
    freeCancelMinutes: numberField(s.freeCancelMinutes, 'freeCancelMinutes', '免费取消时限（分钟）'),
    lateCancel: pick(LATE_CANCEL, s.lateCancel, '超时取消'),
    lateCancelFee: feeField(s.lateCancelFee, '超时取消扣的钱'),
    autoConfirmHours: numberField(s.autoConfirmHours, 'autoConfirmHours', '自动确认完成（小时）')
  }
}

// 开放预约前还差哪几项没填；ways：{ wechat, member } 现在能不能微信付、能不能用余额付
function problems(s, ways) {
  const list = []
  if (!s.hours) list.push('营业时间')
  if (s.slotMinutes === null) list.push('每段时长')
  if (s.hours && s.slotMinutes !== null && minutesOf(s.hours.close) - minutesOf(s.hours.open) < s.slotMinutes) list.push('营业时间比一段还短')
  if (!(s.storeCapacity > 0) && !(s.doorCapacity > 0)) list.push('每段能接几单（到店、上门至少有一个大于 0）')
  if (s.bookDays === null) list.push('能约几天内')
  if (s.leadMinutes === null) list.push('至少提前多久')
  if (s.doorCapacity > 0) {
    if (!s.location) list.push('店的位置（算上门距离用）')
    if (s.doorRadiusKm === null) list.push('上门服务半径')
    if (s.doorFee === null) list.push('上门费（不收填 0）')
    if (!s.outOfRange) list.push('超出半径怎么办')
    if (s.outOfRange === 'fee' && s.outOfRangeFee === null) list.push('超出半径加收多少')
  }
  if (s.freeCancelMinutes === null) list.push('免费取消时限')
  if (!s.lateCancel) list.push('超时取消怎么处理')
  if (s.lateCancel === 'fee' && s.lateCancelFee === null) list.push('超时取消扣多少')
  if (s.autoConfirmHours === null) list.push('多久自动确认完成')
  if (!(ways && ways.wechat) && !s.payLater && !(ways && ways.member)) list.push('付款方式（微信支付、到店付款、会员余额至少开一个）')
  return list
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function hhmm(m) {
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60)
}

// 北京时间这一天 0 点的时间戳
function midnightOf(day) {
  return Date.parse(day + 'T00:00:00Z') - CN_OFFSET
}

function dayLabel(day, index) {
  if (index === 0) return '今天'
  if (index === 1) return '明天'
  const w = new Date(Date.parse(day + 'T00:00:00Z')).getUTCDay()
  return day.slice(5) + ' 周' + WEEK[w]
}

// 能约的时段：[{ day, label, slots: [{ start, end, label }] }]；一段要整个落在营业时间里
function slotDays(s, now) {
  const t = now === undefined ? Date.now() : now
  if (!s.hours || !s.slotMinutes || !s.bookDays) return []
  const open = minutesOf(s.hours.open)
  const close = minutesOf(s.hours.close)
  const earliest = t + (s.leadMinutes || 0) * 60000
  const today = cnDay(t)
  const days = []
  for (let d = 0; d < s.bookDays; d++) {
    const midnight = midnightOf(today) + d * DAY_MS
    const day = cnDay(midnight)
    const slots = []
    for (let m = open; m + s.slotMinutes <= close; m += s.slotMinutes) {
      const start = midnight + m * 60000
      if (start < earliest) continue
      slots.push({ start, end: start + s.slotMinutes * 60000, label: hhmm(m) + '-' + hhmm(m + s.slotMinutes) })
    }
    days.push({ day, label: dayLabel(day, d), slots })
  }
  return days
}

function findSlot(s, start, now) {
  for (const d of slotDays(s, now)) {
    const slot = d.slots.find((x) => x.start === start)
    if (slot) return Object.assign({ day: d.day, dayLabel: d.label }, slot)
  }
  return null
}

function capacityOf(s, mode) {
  return (mode === 'door' ? s.doorCapacity : s.storeCapacity) || 0
}

// 两个经纬度之间的直线距离（公里，保留一位小数）
function distanceKm(a, b) {
  const rad = (x) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 10) / 10
}

// 上门的费用：{ distanceKm, doorFee, extraFee }；超出半径又不接时抛错
function doorCharge(s, where) {
  if (!s.location || !where || !Number.isFinite(where.lat) || !Number.isFinite(where.lng)) {
    throw new BizError('这个地址没有定位，请编辑地址重新选一下位置', 'ADDRESS_NO_LOCATION')
  }
  const km = distanceKm(s.location, where)
  const out = km > s.doorRadiusKm
  if (out && s.outOfRange !== 'fee') {
    throw new BizError('这个地址离店 ' + km + ' 公里，超出了上门范围（' + s.doorRadiusKm + ' 公里），可以选到店', 'OUT_OF_RANGE')
  }
  return { distanceKm: km, doorFee: s.doorFee || 0, extraFee: out ? s.outOfRangeFee || 0 : 0 }
}

// 顾客取消：开始前 freeCancelMinutes 分钟以前免费；之后按 lateCancel：deny 不能在线取消、fee 扣钱、free 照常退
// 返回 { late, fee }，不能取消时抛错
function cancelCharge(s, order, now) {
  const t = now === undefined ? Date.now() : now
  const late = t > order.slotStart - (s.freeCancelMinutes || 0) * 60000
  if (!late) return { late: false, fee: 0 }
  if (s.lateCancel === 'deny') {
    throw new BizError('离开始不到 ' + minutesText(s.freeCancelMinutes || 0) + '，不能在线取消了，请联系店里', 'CANCEL_TOO_LATE')
  }
  return { late: true, fee: s.lateCancel === 'fee' ? s.lateCancelFee || 0 : 0 }
}

function minutesText(m) {
  if (m % 1440 === 0 && m) return m / 1440 + ' 天'
  if (m % 60 === 0 && m) return m / 60 + ' 小时'
  return m + ' 分钟'
}

// 顾客下单页看的规则说明
function policyText(s) {
  const lines = []
  if (s.freeCancelMinutes !== null) {
    lines.push('开始前 ' + minutesText(s.freeCancelMinutes) + '以前可以免费取消')
    if (s.lateCancel === 'deny') lines.push('之后不能在线取消，请联系店里')
    if (s.lateCancel === 'fee') lines.push('之后取消扣 ¥' + (s.lateCancelFee || 0) / 100 + '，用次卡的扣 1 次不退')
    if (s.lateCancel === 'free') lines.push('之后取消也全额退')
  }
  if (s.autoConfirmHours) lines.push('技师完成后 ' + s.autoConfirmHours + ' 小时内没确认的，自动算完成')
  return lines
}

module.exports = {
  SETTINGS_ID,
  NUMBERS,
  readSettings,
  cleanSettings,
  problems,
  slotDays,
  findSlot,
  capacityOf,
  distanceKm,
  doorCharge,
  cancelCharge,
  policyText,
  minutesText
}
