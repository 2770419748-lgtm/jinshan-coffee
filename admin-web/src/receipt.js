// 收银电脑打小票：浏览器打印到默认打印机（小票机）。
// 设置只存在这台电脑的浏览器里：只有收银电脑打开自动打印，别的电脑开着订单页不会重复打。
// 浏览器加了 --kiosk-printing 启动时不弹打印框，直接打（见 README「收银电脑打小票」）。
import { config } from './api'
import { yuan, time, clock, specText, MODE } from './format'

const KEY = 'jinshan-print'
const DEFAULTS = { auto: false, width: 80, copies: 1 }
const PAY_TEXT = { wechat: '微信已付', balance: '余额已付', counter: '吧台已收', voucher: '券抵扣' }

export function loadPrintSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
    return {
      auto: saved.auto === true,
      width: saved.width === 58 ? 58 : 80,
      copies: saved.copies === 2 ? 2 : 1
    }
  } catch (e) {
    return Object.assign({}, DEFAULTS)
  }
}

export function savePrintSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ auto: !!s.auto, width: s.width, copies: s.copies }))
  } catch (e) {
    // 浏览器不让存就算了，只是下次要重新打开
  }
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function payText(o) {
  if (o.payStatus === 'refunded') return '已退款'
  if (o.payStatus !== 'paid') return '未付款，请收款'
  return PAY_TEXT[o.payMethod] || '已付款'
}

function where(o) {
  if (o.reserveAt) return '预约 ' + clock(o.reserveAt) + ' 取' + (o.tableNo ? ' · ' + o.tableNo + ' 号桌' : '')
  if (o.tableNo) return MODE.dine_in + ' · ' + o.tableNo + ' 号桌'
  return MODE[o.mode] || MODE.takeaway
}

function receiptBody(o) {
  const drink = (o.discountFee || 0) - (o.couponFee || 0) - (o.starFee || 0)
  const lines = (o.items || []).map((l) => `
    <div class="line">
      <div class="row"><span class="name">${esc(l.name)}</span><span class="qty">×${l.qty}</span><span class="amt">${yuan(l.subtotal)}</span></div>
      ${l.specs && l.specs.length ? `<div class="spec">${esc(specText(l.specs))}</div>` : ''}
    </div>`).join('')
  return `
  <div class="ticket">
    <div class="shop">${esc(config().shopName || '进山咖啡')}</div>
    <div class="label">取餐号</div>
    <div class="no">${esc(o.pickupNo)}</div>
    <div class="where">${esc(where(o))}</div>
    <div class="muted">下单 ${esc(time(o.createdAt))}</div>
    <div class="hr"></div>
    ${lines}
    <div class="hr"></div>
    ${o.remark ? `<div class="remark">备注：${esc(o.remark)}</div><div class="hr"></div>` : ''}
    <div class="row"><span>商品合计</span><span>¥${yuan(o.totalFee)}</span></div>
    ${drink > 0 ? `<div class="row"><span>赠饮券</span><span>-¥${yuan(drink)}</span></div>` : ''}
    ${o.starRedeem ? `<div class="row"><span>集星换${esc(o.starRedeem.name)}</span><span>-¥${yuan(o.starFee)}</span></div>` : ''}
    ${o.couponFee ? `<div class="row"><span>代金券</span><span>-¥${yuan(o.couponFee)}</span></div>` : ''}
    <div class="row total"><span>实付</span><span>¥${yuan(o.payFee)}</span></div>
    <div class="pay">${esc(payText(o))}</div>
    <div class="muted">单号 ${esc(o.orderNo)}</div>
  </div>`
}

// 58mm 纸能打的宽度大约 48mm，80mm 纸大约 72mm
export function receiptHtml(orders, width, copies) {
  const inner = width === 58 ? 48 : 72
  const base = width === 58 ? 11 : 13
  const tickets = []
  orders.forEach((o) => {
    for (let i = 0; i < (copies || 1); i++) tickets.push(receiptBody(o))
  })
  return `<!doctype html><html><head><meta charset="utf-8"><title>小票</title><style>
    @page { size: ${width}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { width: ${width}mm; font: ${base}px/1.45 "Microsoft YaHei", "PingFang SC", sans-serif; }
    .ticket { width: ${inner}mm; margin: 0 auto; padding: 3mm 0 8mm; page-break-after: always; break-after: page; }
    .ticket:last-child { page-break-after: auto; break-after: auto; }
    .shop { text-align: center; font-size: ${base + 3}px; font-weight: bold; }
    .label { text-align: center; margin-top: 2mm; }
    .no { text-align: center; font-size: ${base * 3}px; font-weight: bold; line-height: 1.1; letter-spacing: 2px; }
    .where { text-align: center; font-size: ${base + 3}px; font-weight: bold; margin: 1mm 0; }
    .muted { text-align: center; font-size: ${base - 1}px; }
    .hr { border-top: 1px dashed #000; margin: 2mm 0; }
    .row { display: flex; gap: 2mm; justify-content: space-between; }
    .line { margin: 1mm 0; }
    .line .row { font-size: ${base + 1}px; font-weight: bold; }
    .name { flex: 1; min-width: 0; word-break: break-all; }
    .qty { width: 9mm; text-align: right; }
    .amt { width: 13mm; text-align: right; }
    .spec { font-size: ${base}px; padding-left: 2mm; }
    .remark { font-size: ${base + 2}px; font-weight: bold; word-break: break-all; }
    .total { font-size: ${base + 3}px; font-weight: bold; margin-top: 1mm; }
    .pay { text-align: center; font-size: ${base + 2}px; font-weight: bold; margin: 2mm 0 1mm; }
  </style></head><body>${tickets.join('')}</body></html>`
}

// 一次只打一批，前一批打完（或 3 秒后）再打下一批，免得同时弹好几个打印
let queue = Promise.resolve()

export function printOrders(orders, settings) {
  const list = (orders || []).filter(Boolean)
  if (!list.length) return queue
  const s = settings || loadPrintSettings()
  queue = queue.then(() => printOnce(receiptHtml(list, s.width, s.copies))).catch(() => {})
  return queue
}

function printOnce(html) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    document.body.appendChild(frame)
    let done = false
    const finish = () => {
      if (done) return
      done = true
      setTimeout(() => {
        frame.remove()
        resolve()
      }, 500)
    }
    frame.onload = () => {
      const win = frame.contentWindow
      win.addEventListener('afterprint', finish)
      win.focus()
      win.print()
      setTimeout(finish, 3000)
    }
    frame.srcdoc = html
  })
}
