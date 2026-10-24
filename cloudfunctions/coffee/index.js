// 咖啡云函数：菜单、下单、订单处理、商品分类桌台管理。
// 读写 coffee_ 开头的集合；下单时核销 vouchers 里的赠饮券（书籍模块包天时发放）。
const cloud = require('wx-server-sdk')
const {
  COFFEE_ROLES,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  requireRole,
  nextSeq,
  createMain
} = require('./lib/base')
const { MAX_PRICE, isFen, buildLines, sanitizeSpecs, applyVouchers } = require('./lib/pricing')
const DEMO_MENU = require('./lib/demo')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const STATUSES = ['pending', 'making', 'done', 'cancelled']
// 订单状态只能按这个方向走
const NEXT_STATUS = {
  pending: ['making', 'cancelled'],
  making: ['done', 'cancelled']
}
const STATUS_TIME_FIELD = { making: 'makingAt', done: 'doneAt', cancelled: 'cancelledAt' }
const TABLE_NO_RE = /^[A-Za-z0-9-]{1,8}$/

const col = (name) => db.collection(name)

async function findOne(name, where) {
  const res = await col(name).where(where).limit(1).get()
  return res.data[0] || null
}

function makeOrderNo() {
  return 'JS' + cnStamp() + String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function formatOrder(order) {
  const out = Object.assign({}, order)
  delete out._openid
  return out
}

function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g
  const pa = String(a).match(re) || []
  const pb = String(b).match(re) || []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === y) continue
    if (/^\d/.test(x) && /^\d/.test(y)) return Number(x) - Number(y)
    return x < y ? -1 : 1
  }
  return pa.length - pb.length
}

function toSort(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

// 顾客今天能用的赠饮券；ids 不传时返回全部
async function usableVouchers(openid, ids) {
  const where = { _openid: openid, status: 'unused', day: cnDay() }
  if (ids) where._id = _.in(ids)
  try {
    const res = await col('vouchers').where(where).limit(50).get()
    return res.data
  } catch (e) {
    if (isMissingCollection(e)) return []
    throw e
  }
}

function voucherIdList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((id) => typeof id === 'string').slice(0, 20)
}

// 订单取消时把用掉的赠饮券退回去
async function releaseVouchers(order) {
  const ids = (order.vouchers || []).map((v) => v.id)
  if (!ids.length) return
  await col('vouchers')
    .where({ _id: _.in(ids), status: 'used', orderNo: order.orderNo })
    .update({ data: { status: 'unused', orderNo: '', orderId: '', usedAt: null } })
}

async function loadLines(items) {
  const ids = []
  ;(Array.isArray(items) ? items : []).forEach((i) => {
    if (i && typeof i.productId === 'string' && ids.indexOf(i.productId) === -1) ids.push(i.productId)
  })
  const res = ids.length
    ? await col('coffee_products').where({ _id: _.in(ids) }).limit(100).get()
    : { data: [] }
  return buildLines(res.data, items)
}

function formatVoucher(v, today) {
  return {
    _id: v._id,
    title: v.title,
    productNames: v.productNames || [],
    maxFee: v.maxFee || 0,
    day: v.day,
    status: v.status === 'unused' && v.day < today ? 'expired' : v.status,
    createdAt: v.createdAt
  }
}

async function deleteFiles(fileIds) {
  const list = fileIds.filter((id) => typeof id === 'string' && id.indexOf('cloud://') === 0)
  if (!list.length) return
  try {
    await cloud.deleteFile({ fileList: list })
  } catch (e) {
    console.warn('deleteFile failed', e)
  }
}

const handlers = {
  // ---------- 顾客端 ----------

  async getMenu() {
    try {
      const [cats, prods] = await Promise.all([
        col('coffee_categories').orderBy('sort', 'asc').limit(100).get(),
        col('coffee_products').where({ onShelf: true }).orderBy('sort', 'asc').limit(500).get()
      ])
      const products = prods.data.map((p) => ({
        _id: p._id,
        categoryId: p.categoryId,
        name: p.name,
        desc: p.desc || '',
        image: p.image || '',
        price: p.price,
        specs: p.specs || [],
        soldOut: !!p.soldOut
      }))
      const used = {}
      products.forEach((p) => { used[p.categoryId] = true })
      const categories = cats.data
        .filter((c) => used[c._id])
        .map((c) => ({ _id: c._id, name: c.name }))
      return { categories, products }
    } catch (e) {
      if (isMissingCollection(e)) return { categories: [], products: [] }
      throw e
    }
  },

  // 结算页算价：按数据库价格算总价，并自动用上今天能用的赠饮券
  async quote({ items }, openid) {
    const { lines, total } = await loadLines(items)
    const vouchers = await usableVouchers(openid)
    const { applied, discount } = applyVouchers(lines, vouchers)
    return { total, vouchers: vouchers.length, applied, discountFee: discount, payFee: total - discount }
  },

  async createOrder({ items, mode, tableNo, remark, voucherIds }, openid) {
    if (mode !== 'dine_in' && mode !== 'takeaway') throw new BizError('请选择堂食或外带')
    const { lines, total } = await loadLines(items)

    let table = ''
    if (mode === 'dine_in' && tableNo) {
      const t = await findOne('coffee_tables', { tableNo: String(tableNo) })
      if (!t) throw new BizError('这个桌码已失效，请重新扫码，或者不选桌号直接下单', 'TABLE_INVALID')
      table = t.tableNo
    }

    // 赠饮券：带条件逐张核销，任何一张对不上就全部退回
    const ids = voucherIdList(voucherIds)
    const vouchers = ids.length ? await usableVouchers(openid, ids) : []
    if (vouchers.length !== ids.length) throw new BizError('赠饮券有变化，请重新确认订单', 'VOUCHER_CHANGED')
    const { applied, discount } = applyVouchers(lines, vouchers)
    const orderNo = makeOrderNo()
    const claimed = []
    const release = () => (claimed.length
      ? col('vouchers').where({ _id: _.in(claimed), orderNo }).update({ data: { status: 'unused', orderNo: '', usedAt: null } })
      : Promise.resolve())
    for (const a of applied) {
      const res = await col('vouchers')
        .where({ _id: a.id, _openid: openid, status: 'unused' })
        .update({ data: { status: 'used', orderNo, usedAt: db.serverDate() } })
      if (!res.stats.updated) {
        await release()
        throw new BizError('赠饮券有变化，请重新确认订单', 'VOUCHER_CHANGED')
      }
      claimed.push(a.id)
    }

    const day = cnDay()
    let added
    try {
      const seq = await nextSeq(db, 'coffee-pickup-' + day)
      const order = {
        _openid: openid,
        orderNo,
        pickupNo: String(seq).padStart(3, '0'),
        seq, // 当天第几单，后台按它排序
        day,
        mode,
        tableNo: table,
        items: lines,
        totalFee: total,
        vouchers: applied,
        discountFee: discount,
        payFee: total - discount,
        remark: cleanText(remark, 50),
        payStatus: 'unpaid',
        payMethod: 'counter', // 第 4 步接入微信支付后会有 wechat
        status: 'pending',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      added = await col('coffee_orders').add({ data: order })
    } catch (e) {
      await release()
      throw e
    }
    if (claimed.length) await col('vouchers').where({ _id: _.in(claimed), orderNo }).update({ data: { orderId: added._id } })
    return { id: added._id }
  },

  // 我的赠饮券：今天能用的，和最近用过、过期的
  async myVouchers(event, openid) {
    const today = cnDay()
    try {
      const res = await col('vouchers').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(50).get()
      const list = res.data.map((v) => formatVoucher(v, today))
      return {
        usable: list.filter((v) => v.status === 'unused'),
        others: list.filter((v) => v.status !== 'unused')
      }
    } catch (e) {
      if (isMissingCollection(e)) return { usable: [], others: [] }
      throw e
    }
  },

  async getOrder({ id }, openid) {
    const order = await findOne('coffee_orders', { _id: String(id || '') })
    if (!order) throw new BizError('订单不存在')
    if (order._openid !== openid) await requireRole(db, openid, COFFEE_ROLES)
    return formatOrder(order)
  },

  async myOrders({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    try {
      const res = await col('coffee_orders')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .skip(p * size)
        .limit(size)
        .get()
      return { orders: res.data.map(formatOrder), hasMore: res.data.length === size }
    } catch (e) {
      if (isMissingCollection(e)) return { orders: [], hasMore: false }
      throw e
    }
  },

  async cancelOrder({ id }, openid) {
    const order = await findOne('coffee_orders', { _id: String(id || ''), _openid: openid })
    if (!order) throw new BizError('订单不存在')
    const res = await col('coffee_orders')
      .where({ _id: order._id, _openid: openid, status: 'pending', payStatus: 'unpaid' })
      .update({ data: { status: 'cancelled', cancelledAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('订单已经开始处理，不能取消了，请联系店员')
    await releaseVouchers(order)
    return true
  },

  // ---------- 咖啡后台：订单 ----------

  async listOrders({ status, day }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const d = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : cnDay()
    const st = STATUSES.indexOf(status) === -1 ? 'pending' : status
    const active = st === 'pending' || st === 'making'
    const [list, counts, pending] = await Promise.all([
      col('coffee_orders').where({ day: d, status: st }).orderBy('seq', active ? 'asc' : 'desc').limit(100).get(),
      Promise.all(STATUSES.map((s) => col('coffee_orders').where({ day: d, status: s }).count())),
      col('coffee_orders').where({ day: d, status: 'pending' }).field({ _id: true }).limit(100).get()
    ])
    const countMap = {}
    STATUSES.forEach((s, i) => { countMap[s] = counts[i].total })
    return {
      day: d,
      orders: list.data.map(formatOrder),
      counts: countMap,
      pendingIds: pending.data.map((o) => o._id)
    }
  },

  async markPaid({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const res = await col('coffee_orders')
      .where({ _id: String(id || ''), payStatus: 'unpaid', status: _.neq('cancelled') })
      .update({ data: { payStatus: 'paid', payMethod: 'counter', paidAt: db.serverDate(), paidBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('订单已收款或已取消')
    return true
  },

  async setOrderStatus({ id, status }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const order = await findOne('coffee_orders', { _id: String(id || '') })
    if (!order) throw new BizError('订单不存在')
    const allowed = NEXT_STATUS[order.status] || []
    if (allowed.indexOf(status) === -1) throw new BizError('订单状态已经变了，请刷新')
    const data = { status, updatedAt: db.serverDate() }
    data[STATUS_TIME_FIELD[status]] = db.serverDate()
    // 带上原状态做条件，防止两位店员同时操作
    const res = await col('coffee_orders').where({ _id: order._id, status: order.status }).update({ data })
    if (!res.stats.updated) throw new BizError('订单状态已经变了，请刷新')
    if (status === 'cancelled') await releaseVouchers(order)
    return true
  },

  // ---------- 咖啡后台：商品和分类 ----------

  async adminListProducts(event, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const [cats, prods] = await Promise.all([
      col('coffee_categories').orderBy('sort', 'asc').limit(100).get(),
      col('coffee_products').orderBy('sort', 'asc').limit(500).get()
    ])
    return { categories: cats.data, products: prods.data }
  },

  async getProduct({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const product = await findOne('coffee_products', { _id: String(id || '') })
    if (!product) throw new BizError('商品不存在')
    return product
  },

  async saveProduct({ product }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const p = product || {}
    const name = cleanText(p.name, 30)
    if (!name) throw new BizError('请填写商品名称')
    const price = Number(p.price)
    if (!isFen(price, MAX_PRICE)) throw new BizError('价格不对，请填 0 到 1000 元')
    const categoryId = String(p.categoryId || '')
    if (!categoryId || !(await findOne('coffee_categories', { _id: categoryId }))) {
      throw new BizError('请选择商品分类')
    }
    const specs = sanitizeSpecs(p.specs)
    const data = {
      name,
      desc: cleanText(p.desc, 60),
      categoryId,
      price,
      image: typeof p.image === 'string' ? p.image.slice(0, 500) : '',
      // 更新时用 _.set 整体替换规格数组
      specs: p._id ? _.set(specs) : specs,
      onShelf: p.onShelf !== false,
      soldOut: !!p.soldOut,
      sort: toSort(p.sort),
      updatedAt: db.serverDate()
    }
    if (p._id) {
      const old = await findOne('coffee_products', { _id: String(p._id) })
      if (!old) throw new BizError('商品不存在')
      await col('coffee_products').doc(old._id).update({ data })
      if (old.image && old.image !== data.image) await deleteFiles([old.image])
      return { id: old._id }
    }
    data.createdAt = db.serverDate()
    const added = await col('coffee_products').add({ data })
    return { id: added._id }
  },

  async setProductFlags({ id, onShelf, soldOut }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const data = { updatedAt: db.serverDate() }
    if (typeof onShelf === 'boolean') data.onShelf = onShelf
    if (typeof soldOut === 'boolean') data.soldOut = soldOut
    const res = await col('coffee_products').where({ _id: String(id || '') }).update({ data })
    if (!res.stats.updated) throw new BizError('商品不存在')
    return true
  },

  async deleteProduct({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const product = await findOne('coffee_products', { _id: String(id || '') })
    if (!product) return true
    await col('coffee_products').doc(product._id).remove()
    await deleteFiles([product.image])
    return true
  },

  async saveCategory({ id, name, sort }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const categoryName = cleanText(name, 10)
    if (!categoryName) throw new BizError('请填写分类名称')
    const dup = await findOne('coffee_categories', { name: categoryName })
    if (dup && dup._id !== id) throw new BizError('已经有「' + categoryName + '」这个分类了')
    if (id) {
      const data = { name: categoryName, updatedAt: db.serverDate() }
      if (sort !== undefined) data.sort = toSort(sort)
      const res = await col('coffee_categories').where({ _id: String(id) }).update({ data })
      if (!res.stats.updated) throw new BizError('分类不存在')
      return { id }
    }
    const count = await col('coffee_categories').count()
    const added = await col('coffee_categories').add({
      data: { name: categoryName, sort: sort === undefined ? count.total : toSort(sort), createdAt: db.serverDate(), updatedAt: db.serverDate() }
    })
    return { id: added._id }
  },

  // ids 按新的顺序排好传进来
  async sortCategories({ ids }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    if (!Array.isArray(ids) || ids.length > 100) throw new BizError('排序数据不对')
    await Promise.all(ids.map((id, index) =>
      col('coffee_categories').where({ _id: String(id) }).update({ data: { sort: index, updatedAt: db.serverDate() } })
    ))
    return true
  },

  async deleteCategory({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const used = await col('coffee_products').where({ categoryId: String(id || '') }).count()
    if (used.total) throw new BizError('这个分类下还有 ' + used.total + ' 个商品，先把商品移走或删除')
    await col('coffee_categories').where({ _id: String(id || '') }).remove()
    return true
  },

  // 第一次试用时导入示例菜单，只在一个商品都没有的时候能用
  async seedDemo(event, openid) {
    await requireRole(db, openid, ['owner'])
    const existing = await col('coffee_products').count()
    if (existing.total) throw new BizError('已经有商品了，不再导入示例菜单')
    let productCount = 0
    for (let i = 0; i < DEMO_MENU.length; i++) {
      const group = DEMO_MENU[i]
      let category = await findOne('coffee_categories', { name: group.category })
      if (!category) {
        const added = await col('coffee_categories').add({
          data: { name: group.category, sort: i, createdAt: db.serverDate(), updatedAt: db.serverDate() }
        })
        category = { _id: added._id }
      }
      for (let j = 0; j < group.products.length; j++) {
        const p = group.products[j]
        await col('coffee_products').add({
          data: {
            name: p.name,
            desc: '示例商品，请在后台改成店里的真实信息',
            categoryId: category._id,
            price: p.price,
            image: '',
            specs: sanitizeSpecs(p.specs),
            onShelf: true,
            soldOut: false,
            sort: j,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
        productCount++
      }
    }
    return { productCount }
  },

  // ---------- 咖啡后台：桌台和桌码 ----------

  async listTables(event, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const res = await col('coffee_tables').limit(200).get()
    return res.data.sort((a, b) => naturalCompare(a.tableNo, b.tableNo))
  },

  async saveTable({ tableNo }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const no = String(tableNo || '').trim().toUpperCase()
    if (!TABLE_NO_RE.test(no)) throw new BizError('桌号只能用字母、数字和横线，最多 8 位，比如 1、A3')
    if (await findOne('coffee_tables', { tableNo: no })) throw new BizError(no + ' 号桌已经有了')
    const added = await col('coffee_tables').add({
      data: { tableNo: no, qrcode: '', qrcodeEnv: '', createdAt: db.serverDate(), updatedAt: db.serverDate() }
    })
    return { id: added._id }
  },

  async deleteTable({ id }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const table = await findOne('coffee_tables', { _id: String(id || '') })
    if (!table) return true
    await col('coffee_tables').doc(table._id).remove()
    await deleteFiles([table.qrcode])
    return true
  },

  // 生成小程序码，扫码打开点单页并带上桌号（scene=t=桌号）
  // envVersion：release 正式版（发布后才能扫开）、trial 体验版（测试用）
  async genTableCode({ id, envVersion }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const table = await findOne('coffee_tables', { _id: String(id || '') })
    if (!table) throw new BizError('桌台不存在')
    const env = envVersion === 'trial' || envVersion === 'develop' ? envVersion : 'release'
    let result
    try {
      result = await cloud.openapi.wxacode.getUnlimited({
        scene: 't=' + table.tableNo,
        page: 'pages/menu/menu',
        checkPath: false,
        envVersion: env,
        width: 600
      })
    } catch (e) {
      console.error('getUnlimited failed', e)
      throw new BizError('生成桌码失败：' + (e.errMsg || e.message || '未知错误'))
    }
    const upload = await cloud.uploadFile({
      cloudPath: 'table-codes/' + env + '/table-' + table.tableNo + '-' + Date.now() + '.png',
      fileContent: result.buffer
    })
    await col('coffee_tables').doc(table._id).update({
      data: { qrcode: upload.fileID, qrcodeEnv: env, updatedAt: db.serverDate() }
    })
    await deleteFiles([table.qrcode])
    return { fileID: upload.fileID, envVersion: env }
  }
}

exports.main = createMain(cloud, handlers)
