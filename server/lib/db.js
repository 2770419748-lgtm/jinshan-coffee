// SQLite 文档数据库：写法和原来的云开发数据库一样（collection / where / doc / command / serverDate），业务代码基本不用改。
// 每个集合一张表：_id 主键 + doc（JSON 文本）。日期存成 {"$date": "ISO 时间"}，读出来还原成 Date。
// 用 Node 自带的 node:sqlite，不用另装数据库；整个库就是一个文件，备份时复制它（或用每天自动备份的副本）。
const { DatabaseSync } = require('node:sqlite')
const crypto = require('crypto')

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const FIELD_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/
const SERVER_DATE = Symbol('serverDate')
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100

// 常用的查询条件建索引；索引表达式要和查询时生成的一模一样才会被用上
const INDEXES = {
  coffee_orders: ['day', '_openid', 'orderNo'],
  coffee_products: ['categoryId'],
  book_rentals: ['day', '_openid', 'rentalNo', 'status'],
  vouchers: ['_openid', 'couponId'],
  members: ['memberNo'],
  member_logs: ['_openid', 'memberNo', 'day'],
  member_recharges: ['rechargeNo'],
  staff: ['role', 'webUsername'],
  staff_invites: ['code'],
  web_sessions: ['staffId'],
  mp_sessions: ['openid']
}

class Cmd {
  constructor(op, value) {
    this.op = op
    this.value = value
  }
}

const command = {
  in: (v) => new Cmd('in', v),
  gt: (v) => new Cmd('gt', v),
  gte: (v) => new Cmd('gte', v),
  lt: (v) => new Cmd('lt', v),
  lte: (v) => new Cmd('lte', v),
  neq: (v) => new Cmd('neq', v),
  set: (v) => new Cmd('set', v),
  inc: (v) => new Cmd('inc', v)
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Cmd) && !v[SERVER_DATE]
}

// 写入前：serverDate 换成当前时间，Date 换成 {$date}
function encode(v) {
  if (v === undefined) return undefined
  if (v && v[SERVER_DATE]) return { $date: new Date().toISOString() }
  if (v instanceof Date) return { $date: v.toISOString() }
  if (v instanceof Cmd) throw new Error('command not allowed here: ' + v.op)
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encode(x)))
  if (v && typeof v === 'object') {
    const out = {}
    Object.keys(v).forEach((k) => {
      const x = encode(v[k])
      if (x !== undefined) out[k] = x
    })
    return out
  }
  return v
}

function reviver(key, v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$date === 'string' && Object.keys(v).length === 1) {
    return new Date(v.$date)
  }
  return v
}

function parseDoc(id, text) {
  const doc = JSON.parse(text, reviver)
  doc._id = id
  return doc
}

function stringifyDoc(doc) {
  const copy = Object.assign({}, doc)
  delete copy._id
  return JSON.stringify(encode(copy))
}

// 更新：_.set 整个替换，_.inc 加数，普通对象和原来的对象合并（只合并一层），其他值直接覆盖
function applyUpdate(doc, data) {
  Object.keys(data).forEach((k) => {
    if (k === '_id') throw new Error('cannot update _id')
    if (!FIELD_RE.test(k) || k.indexOf('.') !== -1) throw new Error('bad field name ' + k)
    const v = data[k]
    if (v instanceof Cmd) {
      if (v.op === 'set') doc[k] = v.value
      else if (v.op === 'inc') doc[k] = (Number(doc[k]) || 0) + v.value
      else throw new Error('unsupported update command ' + v.op)
    } else if (isPlainObject(v)) {
      doc[k] = Object.assign({}, isPlainObject(doc[k]) ? doc[k] : {}, v)
    } else if (v !== undefined) {
      doc[k] = v
    }
  })
}

// 查询条件里字段的取值表达式；日期字段取出 ISO 字符串，方便比较和排序
function valueExpr(field) {
  if (field === '_id') return '_id'
  if (!FIELD_RE.test(field)) throw new Error('bad field name ' + field)
  const path = '$.' + field
  return "COALESCE(json_extract(doc, '" + path + '."$date"' + "'), json_extract(doc, '" + path + "'))"
}

function typeExpr(field) {
  return "json_type(doc, '$." + field + "')"
}

function sqlParam(v, field) {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string' || typeof v === 'number') return v
  throw new Error('unsupported query value for ' + field)
}

function buildWhere(cond) {
  const parts = []
  const params = []
  Object.keys(cond || {}).forEach((field) => {
    const c = cond[field]
    if (field !== '_id' && !FIELD_RE.test(field)) throw new Error('bad field name ' + field)
    if (c instanceof Cmd) {
      if (c.op === 'in') {
        if (!Array.isArray(c.value)) throw new Error('_.in needs an array')
        if (!c.value.length) {
          parts.push('0')
          return
        }
        parts.push(valueExpr(field) + ' IN (' + c.value.map(() => '?').join(', ') + ')')
        c.value.forEach((x) => params.push(sqlParam(x, field)))
        return
      }
      const ops = { gt: '>', gte: '>=', lt: '<', lte: '<=' }
      if (ops[c.op]) {
        parts.push(valueExpr(field) + ' ' + ops[c.op] + ' ?')
        params.push(sqlParam(c.value, field))
        return
      }
      if (c.op === 'neq') {
        if (typeof c.value === 'boolean' || c.value === null) {
          if (field === '_id') throw new Error('bad _id condition')
          parts.push(typeExpr(field) + " IS NOT '" + (c.value === null ? 'null' : String(c.value)) + "'")
        } else {
          parts.push(valueExpr(field) + ' IS NOT ?')
          params.push(sqlParam(c.value, field))
        }
        return
      }
      throw new Error('unsupported query command ' + c.op)
    }
    if (typeof c === 'boolean' || c === null) {
      if (field === '_id') throw new Error('bad _id condition')
      parts.push(typeExpr(field) + " = '" + (c === null ? 'null' : String(c)) + "'")
      return
    }
    parts.push(valueExpr(field) + ' = ?')
    params.push(sqlParam(c, field))
  })
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params }
}

class Query {
  constructor(db, name) {
    this.db = db
    this.name = name
    this.cond = {}
    this.orders = []
    this.skipN = 0
    this.limitN = DEFAULT_LIMIT
    this.projection = null
  }

  copy(change) {
    const q = Object.create(Object.getPrototypeOf(this))
    Object.assign(q, this, { orders: this.orders.slice() }, change)
    return q
  }

  where(cond) { return this.copy({ cond: cond || {} }) }
  orderBy(field, dir) { return this.copy({ orders: this.orders.concat([[field, dir === 'desc' ? 'DESC' : 'ASC']]) }) }
  skip(n) { return this.copy({ skipN: Math.max(0, Number(n) || 0) }) }
  limit(n) { return this.copy({ limitN: Number(n) || 0 }) }
  field(p) { return this.copy({ projection: p }) }

  async get() {
    if (this.limitN > MAX_LIMIT) throw new Error('limit too large')
    const table = this.db.table(this.name)
    const w = buildWhere(this.cond)
    // 同一毫秒写进来的按写入先后排，方向跟着最后一个排序走（倒序列表里后写的在前）
    const tie = this.orders.length ? this.orders[this.orders.length - 1][1] : 'ASC'
    const order = this.orders.map(([f, dir]) => valueExpr(f) + ' ' + dir).concat(['rowid ' + tie]).join(', ')
    const rows = this.db.sql
      .prepare('SELECT _id, doc FROM ' + table + w.sql + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?')
      .all(...w.params, this.limitN, this.skipN)
    let list = rows.map((r) => parseDoc(r._id, r.doc))
    if (this.projection) {
      const keys = Object.keys(this.projection).filter((k) => this.projection[k])
      list = list.map((d) => {
        const out = { _id: d._id }
        keys.forEach((k) => { if (k in d) out[k] = d[k] })
        return out
      })
    }
    return { data: list }
  }

  async count() {
    const table = this.db.table(this.name)
    const w = buildWhere(this.cond)
    const row = this.db.sql.prepare('SELECT COUNT(*) AS n FROM ' + table + w.sql).get(...w.params)
    return { total: Number(row.n) }
  }

  // 按条件更新：查出来、改好、写回，整个过程是同步的，中间不会插进别的请求
  async update({ data }) {
    const table = this.db.table(this.name)
    const w = buildWhere(this.cond)
    let updated = 0
    this.db.atomic(() => {
      const rows = this.db.sql.prepare('SELECT _id, doc FROM ' + table + w.sql).all(...w.params)
      const write = this.db.sql.prepare('UPDATE ' + table + ' SET doc = ? WHERE _id = ?')
      rows.forEach((r) => {
        const doc = parseDoc(r._id, r.doc)
        applyUpdate(doc, data)
        write.run(stringifyDoc(doc), r._id)
      })
      updated = rows.length
    })
    return { stats: { updated } }
  }

  async remove() {
    const table = this.db.table(this.name)
    const w = buildWhere(this.cond)
    const res = this.db.sql.prepare('DELETE FROM ' + table + w.sql).run(...w.params)
    return { stats: { removed: Number(res.changes) } }
  }
}

class DocRef {
  constructor(db, name, id) {
    this.db = db
    this.name = name
    this.id = String(id)
  }

  read() {
    const row = this.db.sql.prepare('SELECT doc FROM ' + this.db.table(this.name) + ' WHERE _id = ?').get(this.id)
    return row ? parseDoc(this.id, row.doc) : null
  }

  async get() {
    const doc = this.read()
    if (!doc) throw new Error('document.get:fail document with _id ' + this.id + ' does not exist')
    return { data: doc }
  }

  // 整条替换，没有就新建
  async set({ data }) {
    if (data && data._id) throw new Error('set data cannot contain _id')
    const table = this.db.table(this.name)
    this.db.sql
      .prepare('INSERT INTO ' + table + ' (_id, doc) VALUES (?, ?) ON CONFLICT(_id) DO UPDATE SET doc = excluded.doc')
      .run(this.id, stringifyDoc(data || {}))
    return { stats: { updated: 1 } }
  }

  async update({ data }) {
    let updated = 0
    this.db.atomic(() => {
      const doc = this.read()
      if (!doc) return
      applyUpdate(doc, data)
      this.db.sql.prepare('UPDATE ' + this.db.table(this.name) + ' SET doc = ? WHERE _id = ?').run(stringifyDoc(doc), this.id)
      updated = 1
    })
    return { stats: { updated } }
  }

  async remove() {
    const res = this.db.sql.prepare('DELETE FROM ' + this.db.table(this.name) + ' WHERE _id = ?').run(this.id)
    return { stats: { removed: Number(res.changes) } }
  }
}

class Collection extends Query {
  doc(id) { return new DocRef(this.db, this.name, id) }

  async add({ data }) {
    const table = this.db.table(this.name)
    const id = data && data._id ? String(data._id) : crypto.randomBytes(16).toString('hex')
    this.db.atomic(() => {
      if (this.db.sql.prepare('SELECT 1 FROM ' + table + ' WHERE _id = ?').get(id)) {
        throw new Error('duplicate key _id ' + id)
      }
      this.db.sql.prepare('INSERT INTO ' + table + ' (_id, doc) VALUES (?, ?)').run(id, stringifyDoc(data || {}))
    })
    return { _id: id }
  }
}

class Database {
  // file 是数据库文件路径；测试里用 ':memory:'
  constructor(file) {
    this.sql = new DatabaseSync(file)
    this.sql.exec('PRAGMA busy_timeout = 5000')
    if (file !== ':memory:') {
      this.sql.exec('PRAGMA journal_mode = WAL')
      this.sql.exec('PRAGMA synchronous = NORMAL')
    }
    this.command = command
    this.tables = new Set()
    this.txChain = Promise.resolve()
    this.depth = 0
  }

  // 集合第一次用到时自动建表
  table(name) {
    if (!NAME_RE.test(name)) throw new Error('bad collection name ' + name)
    const table = 'c_' + name
    if (!this.tables.has(name)) {
      this.sql.exec('CREATE TABLE IF NOT EXISTS ' + table + ' (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)')
      ;(INDEXES[name] || []).forEach((f) => {
        this.sql.exec('CREATE INDEX IF NOT EXISTS ' + table + '_' + f.replace(/\W/g, '_') + ' ON ' + table + ' (' + valueExpr(f) + ')')
      })
      this.tables.add(name)
    }
    return table
  }

  // 同步执行的一组写操作放进一个事务，断电也不会只写一半
  atomic(fn) {
    if (this.depth > 0) return fn()
    this.depth++
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.sql.exec('COMMIT')
      return result
    } catch (e) {
      this.sql.exec('ROLLBACK')
      throw e
    } finally {
      this.depth--
    }
  }

  collection(name) { return new Collection(this, name) }
  serverDate() { return { [SERVER_DATE]: true } }

  async createCollection(name) {
    this.table(name)
  }

  hasCollection(name) {
    return !!this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get('c_' + name)
  }

  // 测试用：删掉整个集合
  dropCollection(name) {
    if (!NAME_RE.test(name)) throw new Error('bad collection name ' + name)
    this.sql.exec('DROP TABLE IF EXISTS c_' + name)
    this.tables.delete(name)
  }

  // 测试用：清空所有集合
  reset() {
    const rows = this.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'c\\_%' ESCAPE '\\'").all()
    rows.forEach((r) => this.sql.exec('DROP TABLE IF EXISTS ' + r.name))
    this.tables.clear()
  }

  // 事务排队执行：里面可以 await，同一时间只跑一个，用在取餐号这种先读后写的地方
  runTransaction(fn) {
    const run = this.txChain.then(() => fn({ collection: (name) => this.collection(name) }))
    this.txChain = run.catch(() => {})
    return run
  }

  // 把整个库复制成一个新文件（备份用），复制过程中照常读写
  backupTo(file) {
    this.sql.prepare('VACUUM INTO ?').run(file)
  }

  close() {
    this.sql.close()
  }
}

module.exports = { Database, command, applyUpdate }
