// 金额都用“分”存整数；后台表单里填“元”
function fenToText(fen) {
  return String((fen || 0) / 100)
}

// 元转分；空着算 0，填错返回 null
function textToFen(text) {
  const s = String(text === undefined || text === null ? '' : text).trim()
  if (s === '') return 0
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

module.exports = { fenToText, textToFen }
