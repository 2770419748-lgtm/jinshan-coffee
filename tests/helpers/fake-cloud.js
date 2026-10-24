// 测试用的 wx-server-sdk 替身：内存数据库，行为尽量贴近云开发（集合不存在会报错、doc().get() 查不到会报错等）
const SERVER_DATE = Symbol('serverDate')

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

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime())
  if (Array.isArray(v)) return v.map(clone)
  if (v && typeof v === 'object') {
    const out = {}
    Object.keys(v).forEach((k) => { out[k] = clone(v[k]) })
    return out
  }
  return v
}

function resolveValue(v) {
  if (v && v[SERVER_DATE]) return new Date()
  if (v instanceof Cmd) throw new Error('command not allowed here: ' + v.op)
  if (Array.isArray(v)) return v.map(resolveValue)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {}
    Object.keys(v).forEach((k) => { out[k] = resolveValue(v[k]) })
    return out
  }
  return v
}

function matches(doc, where) {
  return Object.keys(where).every((k) => {
    const cond = where[k]
    const val = doc[k]
    if (cond instanceof Cmd) {
      if (cond.op === 'in') return cond.value.indexOf(val) !== -1
      if (cond.op === 'gt') return val > cond.value
      if (cond.op === 'gte') return val >= cond.value
      if (cond.op === 'lt') return val < cond.value
      if (cond.op === 'lte') return val <= cond.value
      if (cond.op === 'neq') return val !== cond.value
      throw new Error('unsupported query command ' + cond.op)
    }
    return val === cond
  })
}

function applyUpdate(doc, data) {
  Object.keys(data).forEach((k) => {
    if (k === '_id') throw new Error('cannot update _id')
    const v = data[k]
    if (v instanceof Cmd) {
      if (v.op === 'set') doc[k] = resolveValue(clone(v.value))
      else if (v.op === 'inc') doc[k] = (doc[k] || 0) + v.value
      else throw new Error('unsupported update command ' + v.op)
    } else if (Array.isArray(v)) {
      // 真实环境里数组更新的行为不直观，代码里应该用 _.set
      throw new Error('array update without _.set on field ' + k)
    } else if (v && typeof v === 'object' && !(v instanceof Date) && !v[SERVER_DATE]) {
      doc[k] = Object.assign({}, doc[k] || {}, resolveValue(v))
    } else {
      doc[k] = resolveValue(v)
    }
  })
}

function missing(name) {
  const err = new Error('DATABASE_COLLECTION_NOT_EXIST: ' + name)
  err.errCode = -502005
  err.errMsg = err.message
  return err
}

let idSeq = 0
const newId = () => 'id' + (++idSeq).toString(36) + Math.random().toString(36).slice(2, 6)

class Query {
  constructor(db, name, where) {
    this.db = db
    this.name = name
    this.cond = where || {}
    this.orders = []
    this.skipN = 0
    this.limitN = 100
    this.projection = null
  }

  rows() {
    const store = this.db.store(this.name)
    return Object.keys(store).map((id) => store[id]).filter((d) => matches(d, this.cond))
  }

  where(cond) { const q = this.copy(); q.cond = cond; return q }
  orderBy(field, dir) { const q = this.copy(); q.orders = q.orders.concat([[field, dir]]); return q }
  skip(n) { const q = this.copy(); q.skipN = n; return q }
  limit(n) { const q = this.copy(); q.limitN = n; return q }
  field(p) { const q = this.copy(); q.projection = p; return q }

  copy() {
    const q = new Query(this.db, this.name, this.cond)
    q.orders = this.orders.slice()
    q.skipN = this.skipN
    q.limitN = this.limitN
    q.projection = this.projection
    return q
  }

  async get() {
    if (this.limitN > 1000) throw new Error('limit too large')
    let list = this.rows()
    this.orders.slice().reverse().forEach(([f, dir]) => {
      list = list.slice().sort((a, b) => {
        const x = a[f] instanceof Date ? a[f].getTime() : a[f]
        const y = b[f] instanceof Date ? b[f].getTime() : b[f]
        if (x === y) return 0
        const r = x > y ? 1 : -1
        return dir === 'desc' ? -r : r
      })
    })
    list = list.slice(this.skipN, this.skipN + this.limitN).map(clone)
    if (this.projection) {
      list = list.map((d) => {
        const out = { _id: d._id }
        Object.keys(this.projection).forEach((k) => { if (this.projection[k]) out[k] = d[k] })
        return out
      })
    }
    return { data: list }
  }

  async count() {
    return { total: this.rows().length }
  }

  async update({ data }) {
    const rows = this.rows()
    rows.forEach((d) => applyUpdate(d, data))
    return { stats: { updated: rows.length } }
  }

  async remove() {
    const store = this.db.store(this.name)
    const rows = this.rows()
    rows.forEach((d) => { delete store[d._id] })
    return { stats: { removed: rows.length } }
  }
}

class DocRef {
  constructor(db, name, id) {
    this.db = db
    this.name = name
    this.id = id
  }

  async get() {
    const d = this.db.store(this.name)[this.id]
    if (!d) throw new Error('document.get:fail document with _id ' + this.id + ' does not exist')
    return { data: clone(d) }
  }

  async set({ data }) {
    if (data._id) throw new Error('set data cannot contain _id')
    this.db.store(this.name)[this.id] = Object.assign({ _id: this.id }, resolveValue(clone(data)))
    return { stats: { updated: 1 } }
  }

  async update({ data }) {
    const d = this.db.store(this.name)[this.id]
    if (!d) return { stats: { updated: 0 } }
    applyUpdate(d, data)
    return { stats: { updated: 1 } }
  }

  async remove() {
    const store = this.db.store(this.name)
    const had = !!store[this.id]
    delete store[this.id]
    return { stats: { removed: had ? 1 : 0 } }
  }
}

class Collection extends Query {
  doc(id) { return new DocRef(this.db, this.name, id) }

  async add({ data }) {
    const store = this.db.store(this.name)
    const id = data._id || newId()
    if (store[id]) throw new Error('duplicate key _id ' + id)
    const doc = resolveValue(clone(data))
    doc._id = id
    store[id] = doc
    return { _id: id }
  }
}

class FakeDb {
  constructor() {
    this.collections = {}
    this.command = command
  }

  store(name) {
    if (!this.collections[name]) throw missing(name)
    return this.collections[name]
  }

  collection(name) { return new Collection(this, name) }
  serverDate() { return { [SERVER_DATE]: true } }

  async createCollection(name) {
    if (this.collections[name]) throw new Error('collection already exists')
    this.collections[name] = {}
  }

  // 测试里是单线程，事务直接顺序执行
  async runTransaction(fn) {
    return fn({ collection: (name) => this.collection(name) })
  }

  reset() {
    this.collections = {}
  }
}

const db = new FakeDb()
const state = { openid: '', files: [], deleted: [], envVersion: null }

module.exports = {
  DYNAMIC_CURRENT_ENV: 'dynamic',
  init() {},
  database() { return db },
  getWXContext() { return { OPENID: state.openid } },
  openapi: {
    wxacode: {
      async getUnlimited(params) {
        state.envVersion = params.envVersion
        state.lastCodeParams = params
        return { buffer: Buffer.from('png'), contentType: 'image/png' }
      }
    }
  },
  async uploadFile({ cloudPath }) {
    const fileID = 'cloud://env.test/' + cloudPath
    state.files.push(fileID)
    return { fileID }
  },
  async deleteFile({ fileList }) {
    state.deleted.push.apply(state.deleted, fileList)
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  },
  __db: db,
  __state: state
}
