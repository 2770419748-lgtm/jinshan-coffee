// 书籍云函数：书架、借书、借阅处理、书目和计费规则管理。
// 读写 book_ 开头的集合；包天送咖啡时往 vouchers 里发赠饮券，咖啡下单时核销。
const cloud = require('wx-server-sdk')
const {
  BOOK_ROLES,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  requireRole,
  nextSeq,
  createMain
} = require('./lib/base')
const { sanitizeRule, quoteRental, dueAt, overtime, ruleSummary } = require('./lib/billing')
const DEMO = require('./lib/demo')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const STATUSES = ['pending', 'reading', 'returned', 'cancelled']
// 每位顾客同时最多借几本（含还没取书的）
const MAX_ACTIVE = 3
const ISBN_RE = /^(97[89]\d{10}|\d{9}[\dX])$/
const MAX_COPIES = 99

const col = (name) => db.collection(name)

async function findOne(name, where) {
  const res = await col(name).where(where).limit(1).get()
  return res.data[0] || null
}

function makeRentalNo() {
  return 'JB' + cnStamp() + String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function ms(value) {
  if (!value) return 0
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

// 返回给前端的借阅记录：去掉 openid，在读的带上到期时间和当前超时情况
function formatRental(rental, now) {
  const out = Object.assign({}, rental)
  delete out._openid
  out.dueAtMs = ms(rental.dueAt)
  if (rental.status === 'reading') out.overtimeNow = overtime(rental, now)
  return out
}

function publicBook(b) {
  return {
    _id: b._id,
    title: b.title,
    author: b.author || '',
    cover: b.cover || '',
    category: b.category || '',
    desc: b.desc || '',
    copies: b.copies,
    available: Math.max(0, b.available)
  }
}

function publicRule(r) {
  return {
    _id: r._id,
    name: r.name,
    type: r.type,
    price: r.price,
    desc: r.desc || '',
    minHours: r.minHours,
    maxHours: r.maxHours,
    graceMinutes: r.graceMinutes,
    freeCups: r.freeCups,
    freeProducts: r.freeProducts || [],
    freeMaxFee: r.freeMaxFee,
    summary: ruleSummary(r)
  }
}

function toSort(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

async function shelfRules() {
  const res = await col('book_rules').where({ onShelf: true }).orderBy('sort', 'asc').limit(50).get()
  return res.data.map(publicRule)
}

async function restoreStock(bookId) {
  await col('book_books').where({ _id: bookId }).update({ data: { available: _.inc(1), updatedAt: db.serverDate() } })
}

// 包天付款后发赠饮券，当天有效；券的 _id 跟借阅记录挂钩，重复调用不会多发
async function issueVouchers(rental, openid) {
  for (let i = 0; i < (rental.freeCups || 0); i++) {
    try {
      await col('vouchers').add({
        data: {
          _id: rental._id + '-' + (i + 1),
          _openid: rental._openid,
          source: 'book_rental',
          sourceId: rental._id,
          title: rental.ruleName + '赠饮',
          productIds: (rental.freeProducts || []).map((p) => p.id),
          productNames: (rental.freeProducts || []).map((p) => p.name),
          maxFee: rental.freeMaxFee || 0,
          day: cnDay(),
          status: 'unused',
          orderNo: '',
          orderId: '',
          issuedBy: openid,
          createdAt: db.serverDate()
        }
      })
    } catch (e) {
      if (isMissingCollection(e)) throw e
      // 已经发过
    }
  }
  if (rental.freeCups) {
    await col('book_rentals').doc(rental._id).update({ data: { voucherCount: rental.freeCups } })
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

async function getRentalForStaff(id) {
  const rental = await findOne('book_rentals', { _id: String(id || '') })
  if (!rental) throw new BizError('借阅记录不存在')
  return rental
}

const handlers = {
  // ---------- 顾客端 ----------

  async getShelf() {
    try {
      const [books, rules] = await Promise.all([
        col('book_books').where({ onShelf: true }).orderBy('sort', 'asc').limit(1000).get(),
        shelfRules()
      ])
      const list = books.data.map(publicBook).map((b) => {
        delete b.desc
        return b
      })
      const categories = []
      list.forEach((b) => {
        if (b.category && categories.indexOf(b.category) === -1) categories.push(b.category)
      })
      return { books: list, rules, categories }
    } catch (e) {
      if (isMissingCollection(e)) return { books: [], rules: [], categories: [] }
      throw e
    }
  },

  async getBook({ id }) {
    const book = await findOne('book_books', { _id: String(id || '') })
    if (!book || !book.onShelf) throw new BizError('这本书暂时不在书架上了')
    return { book: publicBook(book), rules: await shelfRules() }
  },

  async createRental({ bookId, ruleId, hours, remark }, openid) {
    const [book, rule] = await Promise.all([
      findOne('book_books', { _id: String(bookId || '') }),
      findOne('book_rules', { _id: String(ruleId || '') })
    ])
    if (!book || !book.onShelf) throw new BizError('这本书暂时不能借了', 'SHELF_CHANGED')
    if (!rule || !rule.onShelf) throw new BizError('这个计费方式已经停用，请重新选择', 'SHELF_CHANGED')
    const quote = quoteRental(rule, hours)
    const active = await col('book_rentals').where({ _openid: openid, status: _.in(['pending', 'reading']) }).count()
    if (active.total >= MAX_ACTIVE) throw new BizError('你已经借了 ' + MAX_ACTIVE + ' 本，先还一本再借吧')

    // 先占一本，防止最后一本被两个人同时借走；后面出错再还回去
    const taken = await col('book_books')
      .where({ _id: book._id, available: _.gt(0) })
      .update({ data: { available: _.inc(-1), updatedAt: db.serverDate() } })
    if (!taken.stats.updated) throw new BizError('这本书刚好被借完了', 'SHELF_CHANGED')
    try {
      const day = cnDay()
      const seq = await nextSeq(db, 'book-rental-' + day)
      const rental = {
        _openid: openid,
        rentalNo: makeRentalNo(),
        code: 'B' + String(seq).padStart(3, '0'), // 到吧台报这个号取书
        seq,
        day,
        bookId: book._id,
        bookTitle: book.title,
        bookAuthor: book.author || '',
        bookCover: book.cover || '',
        // 规则存一份快照，后台改价不影响已经下的单
        ruleId: rule._id,
        ruleName: rule.name,
        ruleType: rule.type,
        unitPrice: rule.price,
        hours: quote.hours,
        graceMinutes: rule.graceMinutes || 0,
        freeCups: rule.freeCups || 0,
        freeProducts: rule.freeProducts || [],
        freeMaxFee: rule.freeMaxFee || 0,
        fee: quote.fee,
        voucherCount: 0,
        remark: cleanText(remark, 50),
        status: 'pending',
        payStatus: 'unpaid',
        payMethod: 'counter',
        startAt: null,
        dueAt: null,
        returnedAt: null,
        overtimeMinutes: 0,
        overtimeFee: 0,
        overtimePayStatus: 'none', // none 没超时；unpaid 待收；paid 已收
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      const added = await col('book_rentals').add({ data: rental })
      return { id: added._id }
    } catch (e) {
      await restoreStock(book._id)
      throw e
    }
  },

  async getRental({ id }, openid) {
    const rental = await findOne('book_rentals', { _id: String(id || '') })
    if (!rental) throw new BizError('借阅记录不存在')
    if (rental._openid !== openid) await requireRole(db, openid, BOOK_ROLES)
    const now = Date.now()
    return Object.assign(formatRental(rental, now), { serverNow: now })
  },

  async myRentals({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const now = Date.now()
    try {
      const res = await col('book_rentals')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .skip(p * size)
        .limit(size)
        .get()
      return { rentals: res.data.map((r) => formatRental(r, now)), hasMore: res.data.length === size, serverNow: now }
    } catch (e) {
      if (isMissingCollection(e)) return { rentals: [], hasMore: false, serverNow: now }
      throw e
    }
  },

  async cancelRental({ id }, openid) {
    const rental = await findOne('book_rentals', { _id: String(id || ''), _openid: openid })
    if (!rental) throw new BizError('借阅记录不存在')
    const res = await col('book_rentals')
      .where({ _id: rental._id, _openid: openid, status: 'pending', payStatus: 'unpaid' })
      .update({ data: { status: 'cancelled', cancelledAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('已经付款或取书了，不能取消，请联系店员')
    await restoreStock(rental.bookId)
    return true
  },

  // ---------- 书籍后台：借阅处理 ----------

  // 待取书、在读不分日期全部列出；已归还、已取消看某一天（默认今天）
  async listRentals({ status, day }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const d = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : cnDay()
    const st = STATUSES.indexOf(status) === -1 ? 'pending' : status
    const whereOf = (s) => (s === 'pending' || s === 'reading' ? { status: s } : { day: d, status: s })
    const active = st === 'pending' || st === 'reading'
    const now = Date.now()
    const [list, counts, pending] = await Promise.all([
      col('book_rentals').where(whereOf(st)).orderBy('day', active ? 'asc' : 'desc').orderBy('seq', active ? 'asc' : 'desc').limit(100).get(),
      Promise.all(STATUSES.map((s) => col('book_rentals').where(whereOf(s)).count())),
      col('book_rentals').where({ status: 'pending' }).field({ _id: true }).limit(100).get()
    ])
    const countMap = {}
    STATUSES.forEach((s, i) => { countMap[s] = counts[i].total })
    return {
      day: d,
      rentals: list.data.map((r) => formatRental(r, now)),
      counts: countMap,
      pendingIds: pending.data.map((r) => r._id),
      serverNow: now
    }
  },

  async markRentalPaid({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    const res = await col('book_rentals')
      .where({ _id: rental._id, payStatus: 'unpaid', status: 'pending' })
      .update({ data: { payStatus: 'paid', payMethod: 'counter', paidAt: db.serverDate(), paidBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('已经收过款或已取消')
    await issueVouchers(rental, openid)
    return { voucherCount: rental.freeCups || 0 }
  },

  // 交书给顾客，开始计时
  async handOut({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    if (rental.status !== 'pending') throw new BizError('这本书已经交给顾客或已取消')
    if (rental.payStatus !== 'paid') throw new BizError('还没收款，先收款再交书')
    const now = Date.now()
    const res = await col('book_rentals')
      .where({ _id: rental._id, status: 'pending', payStatus: 'paid' })
      .update({ data: { status: 'reading', startAt: new Date(now), dueAt: new Date(dueAt(rental, now)), handedBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('状态已经变了，请刷新')
    return { dueAtMs: dueAt(rental, now) }
  },

  // 还书：按小时的超时了就记下超时费，书放回书架
  async returnBook({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    if (rental.status !== 'reading') throw new BizError('这本书不在借阅中')
    const now = Date.now()
    const ot = overtime(rental, now)
    const res = await col('book_rentals')
      .where({ _id: rental._id, status: 'reading' })
      .update({
        data: {
          status: 'returned',
          returnedAt: new Date(now),
          returnedBy: openid,
          overtimeMinutes: ot.minutes,
          overtimeFee: ot.fee,
          overtimePayStatus: ot.fee ? 'unpaid' : 'none',
          updatedAt: db.serverDate()
        }
      })
    if (!res.stats.updated) throw new BizError('状态已经变了，请刷新')
    await restoreStock(rental.bookId)
    return { overtimeMinutes: ot.minutes, overtimeHours: ot.hours, overtimeFee: ot.fee }
  },

  async markOvertimePaid({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const res = await col('book_rentals')
      .where({ _id: String(id || ''), overtimePayStatus: 'unpaid' })
      .update({ data: { overtimePayStatus: 'paid', overtimePayMethod: 'counter', overtimePaidAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('没有待收的超时费')
    return true
  },

  // 店员取消：书放回书架，没用的赠饮券作废；已收款的要线下退款
  async adminCancelRental({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    if (rental.status !== 'pending' && rental.status !== 'reading') throw new BizError('这条借阅已经结束了')
    const res = await col('book_rentals')
      .where({ _id: rental._id, status: rental.status })
      .update({ data: { status: 'cancelled', cancelledAt: db.serverDate(), cancelledBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('状态已经变了，请刷新')
    await restoreStock(rental.bookId)
    let voided = 0
    if (rental.voucherCount) {
      const v = await col('vouchers').where({ sourceId: rental._id, status: 'unused' }).update({ data: { status: 'void' } })
      voided = v.stats.updated
    }
    return { paid: rental.payStatus === 'paid', voidedVouchers: voided }
  },

  // ---------- 书籍后台：书目 ----------

  async adminListBooks(event, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const res = await col('book_books').orderBy('sort', 'asc').limit(1000).get()
    return res.data
  },

  async getBookAdmin({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const book = await findOne('book_books', { _id: String(id || '') })
    if (!book) throw new BizError('书不存在')
    return book
  },

  async saveBook({ book }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const b = book || {}
    const title = cleanText(b.title, 40)
    if (!title) throw new BizError('请填写书名')
    const copies = Number(b.copies)
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new BizError('册数请填 1 到 ' + MAX_COPIES)
    const isbn = String(b.isbn || '').replace(/[\s-]/g, '').toUpperCase()
    if (isbn && !ISBN_RE.test(isbn)) throw new BizError('ISBN 格式不对，应该是 10 位或 13 位')
    if (isbn) {
      const dup = await findOne('book_books', { isbn })
      if (dup && dup._id !== b._id) throw new BizError('《' + dup.title + '》已经录入过这个 ISBN 了，改册数就行')
    }
    const data = {
      title,
      author: cleanText(b.author, 30),
      isbn,
      cover: typeof b.cover === 'string' ? b.cover.slice(0, 500) : '',
      category: cleanText(b.category, 10),
      desc: cleanText(b.desc, 300),
      onShelf: b.onShelf !== false,
      sort: toSort(b.sort),
      updatedAt: db.serverDate()
    }
    if (b._id) {
      const old = await findOne('book_books', { _id: String(b._id) })
      if (!old) throw new BizError('书不存在')
      const delta = copies - old.copies
      const out = old.copies - old.available // 借出去的
      if (delta < 0 && copies < out) throw new BizError('现在有 ' + out + ' 本借出去了，册数不能少于 ' + out)
      data.copies = copies
      data.available = _.inc(delta)
      // 带上原册数做条件，防止同时有人借书时算错可借数量
      const res = await col('book_books').where({ _id: old._id, copies: old.copies, available: _.gte(-delta) }).update({ data })
      if (!res.stats.updated) throw new BizError('刚好有人借还书，请重新保存')
      if (old.cover && old.cover !== data.cover) await deleteFiles([old.cover])
      return { id: old._id }
    }
    data.copies = copies
    data.available = copies
    data.createdAt = db.serverDate()
    const added = await col('book_books').add({ data })
    return { id: added._id }
  },

  async setBookFlags({ id, onShelf }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    if (typeof onShelf !== 'boolean') throw new BizError('参数不对')
    const res = await col('book_books').where({ _id: String(id || '') }).update({ data: { onShelf, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('书不存在')
    return true
  },

  async deleteBook({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const book = await findOne('book_books', { _id: String(id || '') })
    if (!book) return true
    const out = book.copies - book.available
    if (out > 0) throw new BizError('还有 ' + out + ' 本没还，还回来以后再删除')
    await col('book_books').doc(book._id).remove()
    await deleteFiles([book.cover])
    return true
  },

  // ---------- 书籍后台：计费规则 ----------

  async adminListRules(event, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const res = await col('book_rules').orderBy('sort', 'asc').limit(100).get()
    return res.data.map((r) => Object.assign({}, r, { summary: ruleSummary(r) }))
  },

  async getRule({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rule = await findOne('book_rules', { _id: String(id || '') })
    if (!rule) throw new BizError('规则不存在')
    return rule
  },

  async saveRule({ rule }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const r = rule || {}
    const data = sanitizeRule(r)
    data.freeProducts = r._id ? _.set(data.freeProducts) : data.freeProducts
    data.updatedAt = db.serverDate()
    if (r._id) {
      const res = await col('book_rules').where({ _id: String(r._id) }).update({ data })
      if (!res.stats.updated) throw new BizError('规则不存在')
      return { id: r._id }
    }
    data.createdAt = db.serverDate()
    const added = await col('book_rules').add({ data })
    return { id: added._id }
  },

  async setRuleFlags({ id, onShelf }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    if (typeof onShelf !== 'boolean') throw new BizError('参数不对')
    const res = await col('book_rules').where({ _id: String(id || '') }).update({ data: { onShelf, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('规则不存在')
    return true
  },

  // 已经下的单存了规则快照，删规则不影响
  async deleteRule({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    await col('book_rules').where({ _id: String(id || '') }).remove()
    return true
  },

  // 第一次试用：一本书、一条规则都没有时导入示例
  async seedDemo(event, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const [books, rules] = await Promise.all([col('book_books').count(), col('book_rules').count()])
    if (books.total || rules.total) throw new BizError('已经有书或计费规则了，不再导入示例')
    for (let i = 0; i < DEMO.rules.length; i++) {
      const data = sanitizeRule(Object.assign({ sort: i }, DEMO.rules[i]))
      data.createdAt = db.serverDate()
      data.updatedAt = db.serverDate()
      await col('book_rules').add({ data })
    }
    for (let i = 0; i < DEMO.books.length; i++) {
      const b = DEMO.books[i]
      await col('book_books').add({
        data: {
          title: b.title,
          author: b.author,
          isbn: '',
          cover: '',
          category: b.category,
          desc: '示例书目，请在后台改成店里的真实书籍',
          copies: b.copies,
          available: b.copies,
          onShelf: true,
          sort: i,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
    }
    return { bookCount: DEMO.books.length, ruleCount: DEMO.rules.length }
  }
}

exports.main = createMain(cloud, handlers)
