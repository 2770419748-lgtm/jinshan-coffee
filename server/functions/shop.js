// 店铺设置（settings 集合里 _id 为 shop 的那条）：微信支付开关、能不能到吧台付、营业时间。
// 预约的可选时间也在这里算：今天和明天、营业时间内、每 15 分钟一档、至少提前 30 分钟。
const { BizError, isMissingCollection, cnDay } = require('./base')

const DEFAULT_HOURS = { open: '08:00', close: '22:00' }
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const SLOT_MINUTES = 15
const RESERVE_LEAD_MINUTES = 30
const RESERVE_DAYS = 2 // 今天和明天
const CN_OFFSET = 8 * 3600 * 1000

async function readShop(db) {
  try {
    const res = await db.collection('settings').where({ _id: 'shop' }).limit(1).get()
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

function hoursOf(saved) {
  const h = (saved && saved.hours) || {}
  const open = minutesOf(h.open)
  const close = minutesOf(h.close)
  if (open === null || close === null || close <= open) return Object.assign({}, DEFAULT_HOURS)
  return { open: h.open, close: h.close }
}

// 后台保存营业时间时检查：开门、打烊都是 HH:MM，打烊要晚于开门（不支持跨过零点）
function checkHours(hours) {
  const open = minutesOf(hours && hours.open)
  const close = minutesOf(hours && hours.close)
  if (open === null || close === null) throw new BizError('营业时间格式不对，例如 08:00')
  if (close <= open) throw new BizError('打烊时间要晚于开门时间')
  return { open: hours.open, close: hours.close }
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 能预约的时间：[{ at: 毫秒时间戳, label: '今天 15:30' }]
function reserveSlots(hours, now) {
  const t = now === undefined ? Date.now() : now
  const open = minutesOf(hours.open)
  const close = minutesOf(hours.close)
  const earliest = t + RESERVE_LEAD_MINUTES * 60000
  const today = cnDay(t)
  const slots = []
  for (let d = 0; d < RESERVE_DAYS; d++) {
    // 北京时间这一天 0 点对应的时间戳
    const midnight = Date.parse(today + 'T00:00:00Z') - CN_OFFSET + d * 86400000
    for (let m = open; m < close; m += SLOT_MINUTES) {
      const at = midnight + m * 60000
      if (at < earliest) continue
      slots.push({ at, label: (d === 0 ? '今天 ' : '明天 ') + pad(Math.floor(m / 60)) + ':' + pad(m % 60) })
    }
  }
  return slots
}

module.exports = { DEFAULT_HOURS, SLOT_MINUTES, readShop, hoursOf, checkHours, reserveSlots }
