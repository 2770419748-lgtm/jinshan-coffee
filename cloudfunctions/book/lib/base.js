// 每个云函数（common、coffee、book）各放一份这个文件，改的时候几份一起改。
// tests/shared-files.test.js 会检查各份内容一致。

const ROLES = {
  owner: '店主',
  barista: '咖啡师',
  book_manager: '书籍管理员'
}

// 能进咖啡后台、书籍后台的角色
const COFFEE_ROLES = ['owner', 'barista']
const BOOK_ROLES = ['owner', 'book_manager']

// 咖啡模块用 coffee_ 开头的集合，书籍模块用 book_ 开头的集合；
// vouchers 是包天送的赠饮券，书籍模块发放，咖啡下单时核销
const COLLECTIONS = [
  'staff',
  'staff_invites',
  'counters',
  'coffee_categories',
  'coffee_products',
  'coffee_orders',
  'coffee_tables',
  'book_books',
  'book_rules',
  'book_rentals',
  'vouchers'
]

class BizError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code || 'BAD_REQUEST'
  }
}

function isMissingCollection(err) {
  const text = String((err && (err.errMsg || err.message)) || '')
  return (err && err.errCode === -502005) || /DATABASE_COLLECTION_NOT_EXIST|collection not exists?/i.test(text)
}

// 去掉首尾空白和换行，按字符截断
function cleanText(value, max) {
  if (value === undefined || value === null) return ''
  const s = String(value).replace(/[\r\n\t]+/g, ' ').trim()
  return Array.from(s).slice(0, max).join('')
}

// 中国时间（UTC+8）的日期，例如 2026-10-24；云函数默认跑在 UTC
function cnDay(now) {
  const t = (now === undefined ? Date.now() : now) + 8 * 3600 * 1000
  return new Date(t).toISOString().slice(0, 10)
}

function cnStamp(now) {
  const t = (now === undefined ? Date.now() : now) + 8 * 3600 * 1000
  return new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

async function ensureCollections(db) {
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name)
    } catch (e) {
      // 已存在就跳过
    }
  }
}

async function getStaff(db, openid) {
  if (!openid) return null
  try {
    const res = await db.collection('staff').where({ _id: openid }).limit(1).get()
    return res.data[0] || null
  } catch (e) {
    if (isMissingCollection(e)) return null
    throw e
  }
}

async function requireRole(db, openid, roles) {
  const staff = await getStaff(db, openid)
  if (!staff || roles.indexOf(staff.role) === -1) {
    throw new BizError('没有权限，请让店主在「员工管理」里给你开通', 'FORBIDDEN')
  }
  return staff
}

// 每天的流水号从 1 开始（取餐号、借书号）
async function nextSeq(db, counterId) {
  try {
    await db.collection('counters').add({ data: { _id: counterId, seq: 0 } })
  } catch (e) {
    // 计数器已存在
  }
  return db.runTransaction(async (t) => {
    const res = await t.collection('counters').doc(counterId).get()
    const seq = (res.data.seq || 0) + 1
    await t.collection('counters').doc(counterId).update({ data: { seq } })
    return seq
  })
}

function publicStaff(staff) {
  if (!staff) return null
  return { name: staff.name, role: staff.role, roleName: ROLES[staff.role] || staff.role }
}

// 统一的云函数入口：handlers[action](event, openid)，返回 { ok, data } 或 { ok: false, msg, code }
// 新版本加了集合、数据库里还没有时，自动建好再试一次
function createMain(cloud, handlers) {
  return async (event) => {
    const { OPENID } = cloud.getWXContext()
    const handler = handlers[event && event.action]
    if (!handler) return { ok: false, msg: '未知操作', code: 'UNKNOWN_ACTION' }
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await handler(event, OPENID)
        return { ok: true, data: data === undefined ? null : data }
      } catch (e) {
        if (e instanceof BizError) return { ok: false, msg: e.message, code: e.code }
        if (attempt === 0 && isMissingCollection(e)) {
          await ensureCollections(cloud.database())
          continue
        }
        console.error('[' + event.action + ']', e)
        return { ok: false, msg: '服务器开小差了，请稍后再试', code: 'SERVER_ERROR' }
      }
    }
  }
}

module.exports = {
  ROLES,
  COFFEE_ROLES,
  BOOK_ROLES,
  COLLECTIONS,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  ensureCollections,
  getStaff,
  requireRole,
  nextSeq,
  publicStaff,
  createMain
}
