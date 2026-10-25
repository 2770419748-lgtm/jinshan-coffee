// 金额都用“分”存整数
function fenToText(fen) {
  return String((fen || 0) / 100)
}

module.exports = { fenToText }
