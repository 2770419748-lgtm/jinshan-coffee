// 金额、时间、状态的显示格式
export function yuan(fen) {
  const n = (fen || 0) / 100
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
}

const pad = (n) => (n < 10 ? '0' + n : '' + n)

// 店在中国，日期都按北京时间
export function cnDay(ms) {
  const t = (ms === undefined ? Date.now() : ms) + 8 * 3600 * 1000
  return new Date(t).toISOString().slice(0, 10)
}

export function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
}

export function time(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export function clock(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export function minutes(m) {
  const n = Math.max(0, Math.round(m || 0))
  const h = Math.floor(n / 60)
  const rest = n % 60
  if (!h) return rest + ' 分钟'
  return h + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '')
}

export function left(dueAtMs, now) {
  if (!dueAtMs) return ''
  const diff = Math.round((dueAtMs - now) / 60000)
  return diff >= 0 ? '还剩 ' + minutes(diff) : '已超时 ' + minutes(-diff)
}

export const ORDER_STATUS = { pending: '待制作', making: '制作中', done: '已完成', cancelled: '已取消' }
export const RENTAL_STATUS = { pending: '待取书', reading: '在读', returned: '已归还', cancelled: '已取消' }
export const RULE_TYPE = { hourly: '按小时', day: '包天' }
export const MODE = { dine_in: '堂食', takeaway: '外带' }
export const ROLE_OPTIONS = [
  { value: 'owner', label: '店主（全部权限）' },
  { value: 'barista', label: '咖啡师（只管咖啡）' },
  { value: 'book_manager', label: '书籍管理员（只管书籍）' }
]

export function specText(specs) {
  return (specs || []).map((s) => s.option).join(' / ')
}

export function rentalBrief(r) {
  return r.ruleType === 'hourly' ? r.ruleName + ' · ' + r.hours + ' 小时' : r.ruleName
}

// 元转分；空着算 0，填错返回 null
export function toFen(value) {
  const s = String(value === undefined || value === null ? '' : value).trim()
  if (s === '') return 0
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

// 导出 CSV：加 BOM，Excel 和 WPS 打开不乱码
export function downloadCsv(filename, rows) {
  const text = rows.map((row) => row.map((cell) => {
    const v = cell === undefined || cell === null ? '' : String(cell)
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
  }).join(',')).join('\r\n')
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// 简单的 CSV 解析：支持引号、引号里的逗号和换行
export function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''))
}
