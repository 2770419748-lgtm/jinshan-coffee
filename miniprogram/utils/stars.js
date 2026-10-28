// 集星：把后台配的规则写成几句话给顾客看，算集星卡上的星星格子
function scope(all, names) {
  return all ? '' : '「' + (names.length ? names.join('」「') : '指定分类') + '」'
}

// info：服务器 myStars 返回的 { need, earnAll, earnNames, redeemAll, redeemNames, maxFee, validDays }
function ruleLines(info) {
  const lines = []
  lines.push('每买一件' + scope(info.earnAll, info.earnNames) + '商品得 1 颗星，出餐后到账；到吧台付款的，店员确认收款后到账。')
  lines.push('集满 ' + info.need + ' 颗星，下单时能免费换一杯' + (info.redeemAll ? '' : '（限' + scope(false, info.redeemNames) + '）') +
    (info.maxFee ? '，最多抵 ¥' + info.maxFee / 100 : '') + '，每单限换一杯。')
  lines.push('用券或用星免费的那一杯不得星。')
  lines.push(info.validDays ? '每颗星从得到那天起 ' + info.validDays + ' 天内有效，换的时候先用最早的。' : '星星一直有效。')
  lines.push('订单取消后，用掉的星星会退回。')
  return lines
}

// 集星卡上的格子：最多画 20 格，再多就画进度条（返回空数组）
function dots(stars, need) {
  if (!need || need > 20) return []
  const list = []
  for (let i = 0; i < need; i++) list.push({ i, on: i < stars })
  return list
}

// 「再集 3 颗换一杯」「可以换 1 杯了」
function tip(stars, need) {
  if (!need) return ''
  if (stars >= need) return '可以换 ' + Math.floor(stars / need) + ' 杯了，下单时打开「用星换一杯」'
  return '再集 ' + (need - stars) + ' 颗换一杯'
}

module.exports = { ruleLines, dots, tip }
