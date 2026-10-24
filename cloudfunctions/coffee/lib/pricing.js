// 价格都用“分”存整数，避免小数误差。下单金额只在云端按数据库里的价格计算，不信任前端传来的价格。
const { BizError, cleanText } = require('./base')

const MAX_LINES = 30
const MAX_QTY = 99
const MAX_PRICE = 100000 // 1000 元
const MAX_EXTRA = 10000 // 规格加价最多 100 元

function isFen(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max
}

// 校验顾客选的规格：每组规格必须选一个存在的选项
function pickSpecs(product, chosen) {
  const groups = product.specs || []
  const list = Array.isArray(chosen) ? chosen : []
  let extra = 0
  const specs = groups.map((group) => {
    const pick = list.find((s) => s && s.name === group.name)
    const option = pick && (group.options || []).find((o) => o.name === pick.option)
    if (!option) {
      throw new BizError('「' + product.name + '」的' + group.name + '有变化，请重新选择', 'MENU_CHANGED')
    }
    extra += option.price || 0
    return { name: group.name, option: option.name }
  })
  return { specs, extra }
}

// products：数据库里查到的商品；items：前端提交的 [{ productId, qty, specs }]
function buildLines(products, items) {
  if (!Array.isArray(items) || !items.length) throw new BizError('购物车是空的')
  if (items.length > MAX_LINES) throw new BizError('一次最多点 ' + MAX_LINES + ' 种')
  const byId = {}
  products.forEach((p) => { byId[p._id] = p })

  let total = 0
  const lines = items.map((item) => {
    const qty = Number(item && item.qty)
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new BizError('商品数量不对')
    const product = byId[item.productId]
    if (!product || !product.onShelf) {
      throw new BizError('有商品已下架，请回到菜单重新选择', 'MENU_CHANGED')
    }
    if (product.soldOut) throw new BizError('「' + product.name + '」已售罄', 'MENU_CHANGED')
    const { specs, extra } = pickSpecs(product, item.specs)
    const unitPrice = product.price + extra
    const subtotal = unitPrice * qty
    total += subtotal
    return {
      productId: product._id,
      name: product.name,
      image: product.image || '',
      specs,
      unitPrice,
      qty,
      subtotal
    }
  })
  return { lines, total }
}

// 后台保存商品时整理规格：最多 5 组，每组 1 到 10 个选项
function sanitizeSpecs(specs) {
  if (specs === undefined || specs === null) return []
  if (!Array.isArray(specs)) throw new BizError('规格格式不对')
  if (specs.length > 5) throw new BizError('规格最多 5 组')
  const groupNames = {}
  return specs.map((group) => {
    const name = cleanText(group && group.name, 10)
    if (!name) throw new BizError('规格名称不能为空')
    if (groupNames[name]) throw new BizError('规格「' + name + '」重复了')
    groupNames[name] = true
    const options = Array.isArray(group.options) ? group.options : []
    if (!options.length || options.length > 10) throw new BizError('「' + name + '」需要 1 到 10 个选项')
    const optionNames = {}
    return {
      name,
      options: options.map((o) => {
        const optionName = cleanText(o && o.name, 10)
        if (!optionName) throw new BizError('「' + name + '」有选项没填名称')
        if (optionNames[optionName]) throw new BizError('「' + name + '」的选项「' + optionName + '」重复了')
        optionNames[optionName] = true
        const price = o.price === undefined || o.price === '' ? 0 : Number(o.price)
        if (!isFen(price, MAX_EXTRA)) throw new BizError('「' + optionName + '」的加价不对')
        return { name: optionName, price }
      })
    }
  })
}

// 包天送的赠饮券：每张抵扣一杯。在券允许的商品里挑单价最高、还没被抵扣的那一杯；
// 限定了商品的券先挑，免得通用券把它能用的那杯占掉。用不上的券不算进去，也不会被核销。
// vouchers：[{ _id, title, productIds（空表示不限商品）, maxFee（每杯最多抵扣，0 表示不封顶） }]
function applyVouchers(lines, vouchers) {
  const covered = lines.map(() => 0)
  const sorted = (vouchers || []).slice().sort((a, b) => {
    const x = (a.productIds || []).length || Infinity
    const y = (b.productIds || []).length || Infinity
    return x - y
  })
  const applied = []
  sorted.forEach((v) => {
    const allowed = v.productIds || []
    let best = -1
    let bestValue = 0
    lines.forEach((line, i) => {
      if (covered[i] >= line.qty) return
      if (allowed.length && allowed.indexOf(line.productId) === -1) return
      const value = v.maxFee ? Math.min(line.unitPrice, v.maxFee) : line.unitPrice
      if (value > bestValue) {
        best = i
        bestValue = value
      }
    })
    if (best === -1) return
    covered[best]++
    applied.push({ id: v._id, title: v.title || '赠饮券', productId: lines[best].productId, name: lines[best].name, discount: bestValue })
  })
  const discount = applied.reduce((sum, a) => sum + a.discount, 0)
  return { applied, discount }
}

module.exports = { MAX_PRICE, isFen, buildLines, sanitizeSpecs, applyVouchers }
