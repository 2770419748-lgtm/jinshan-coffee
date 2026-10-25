// 购物车存在本地。价格用“分”，最终金额以服务器计算为准。
const KEY = 'jinshan_cart'

function load() {
  try {
    return wx.getStorageSync(KEY) || []
  } catch (e) {
    return []
  }
}

function save(list) {
  wx.setStorageSync(KEY, list)
  return list
}

function keyOf(productId, specs) {
  return productId + '|' + (specs || []).map((s) => s.name + ':' + s.option).join(',')
}

// 按商品当前的规格算单价；规格对不上时返回 null
function unitPrice(product, specs) {
  let price = product.price
  const groups = product.specs || []
  for (let i = 0; i < groups.length; i++) {
    const pick = (specs || []).find((s) => s.name === groups[i].name)
    const option = pick && groups[i].options.find((o) => o.name === pick.option)
    if (!option) return null
    price += option.price || 0
  }
  return price
}

function specText(specs) {
  return (specs || []).map((s) => s.option).join(' / ')
}

function add(product, specs, qty) {
  const list = load()
  const key = keyOf(product._id, specs)
  const found = list.find((i) => i.key === key)
  if (found) {
    found.qty = Math.min(99, found.qty + qty)
  } else {
    list.push({
      key,
      productId: product._id,
      name: product.name,
      image: product.image || '',
      specs,
      specText: specText(specs),
      unitPrice: unitPrice(product, specs),
      qty
    })
  }
  return save(list)
}

function setQty(key, qty) {
  const list = load()
  const next = qty <= 0
    ? list.filter((i) => i.key !== key)
    : list.map((i) => (i.key === key ? Object.assign({}, i, { qty: Math.min(99, qty) }) : i))
  return save(next)
}

function clear() {
  return save([])
}

function summary(list) {
  return list.reduce((acc, i) => {
    acc.count += i.qty
    acc.total += i.unitPrice * i.qty
    return acc
  }, { count: 0, total: 0 })
}

// 菜单更新后同步购物车：下架、售罄、规格变了的去掉，价格按最新的算
function syncWithMenu(list, products) {
  const byId = {}
  products.forEach((p) => { byId[p._id] = p })
  let changed = false
  const next = []
  list.forEach((item) => {
    const p = byId[item.productId]
    const price = p && !p.soldOut ? unitPrice(p, item.specs) : null
    if (price === null) {
      changed = true
      return
    }
    if (price !== item.unitPrice || p.name !== item.name || (p.image || '') !== item.image) changed = true
    next.push(Object.assign({}, item, { unitPrice: price, name: p.name, image: p.image || '' }))
  })
  return { list: next, changed }
}

module.exports = { load, save, keyOf, unitPrice, specText, add, setQty, clear, summary, syncWithMenu }
