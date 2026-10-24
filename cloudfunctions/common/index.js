// 公共云函数：登录、店主绑定、员工邀请和权限管理
const crypto = require('crypto')
const { promisify } = require('util')
const cloud = require('wx-server-sdk')
const {
  ROLES,
  WEB_SESSION_TTL,
  BizError,
  isMissingCollection,
  cleanText,
  ensureCollections,
  getStaff,
  requireRole,
  hashToken,
  publicStaff,
  createMain
} = require('./lib/base')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const INVITE_TTL = 24 * 3600 * 1000
const scrypt = promisify(crypto.scrypt)
const USERNAME_RE = /^[a-z0-9_]{3,20}$/
// 网页后台连续输错 5 次密码锁 15 分钟
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000
// 网页后台扫码登录：二维码 3 分钟有效，手机上确认后网页 1 分钟内要来取
const LOGIN_TICKET_TTL = 3 * 60 * 1000
const LOGIN_CONFIRM_TTL = 60 * 1000
const LOGIN_PAGE = 'admin/pages/web-login/web-login'
const TICKET_RE = /^[A-Za-z0-9]{20}$/
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

async function hashPassword(password, salt) {
  const key = await scrypt(String(password), salt, 32)
  return key.toString('hex')
}

async function countOwners() {
  const res = await db.collection('staff').where({ role: 'owner' }).count()
  return res.total
}

function randomCode() {
  return String(100000 + (crypto.randomBytes(4).readUInt32BE(0) % 900000))
}

function randomId(len) {
  const bytes = crypto.randomBytes(len)
  let id = ''
  for (let i = 0; i < len; i++) id += BASE62[bytes[i] % 62]
  return id
}

async function createSession(staff) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + WEB_SESSION_TTL
  await db.collection('web_sessions').add({
    data: { _id: hashToken(token), staffId: staff._id, expiresAt, createdAt: db.serverDate() }
  })
  return { token, expiresAt, staff: publicStaff(staff) }
}

// 扫码登录用的小程序码。小程序还没发布（或者发布的版本里还没有确认页）时，正式版会报 41030，改用体验版
async function loginCode(id) {
  const base = { scene: 'w=' + id, page: LOGIN_PAGE, width: 430 }
  try {
    const result = await cloud.openapi.wxacode.getUnlimited(Object.assign({ checkPath: true, envVersion: 'release' }, base))
    return { envVersion: 'release', result }
  } catch (e) {
    if (e.errCode !== 41030) throw e
  }
  const result = await cloud.openapi.wxacode.getUnlimited(Object.assign({ checkPath: false, envVersion: 'trial' }, base))
  return { envVersion: 'trial', result }
}

async function findTicket(id) {
  const key = String(id || '')
  const res = TICKET_RE.test(key) ? await db.collection('web_login_tickets').where({ _id: key }).limit(1).get() : { data: [] }
  if (!res.data[0]) throw new BizError('登录码不存在，请在电脑上刷新二维码', 'TICKET_GONE')
  return res.data[0]
}

// waiting 等手机确认、confirmed 已确认等网页来取、used 已登录、cancelled 手机上取消了、expired 过期
function ticketStatus(ticket) {
  if ((ticket.status === 'waiting' || ticket.status === 'confirmed') && ticket.expiresAt <= Date.now()) return 'expired'
  return ticket.status
}

async function requireAnyStaff(openid) {
  const staff = await getStaff(db, openid)
  if (!staff) throw new BizError('只有店主和员工能登录网页后台', 'FORBIDDEN')
  return staff
}

const handlers = {
  // 每次打开小程序调用：返回当前用户是不是员工、店里有没有绑定店主
  async login(event, openid) {
    let staff = null
    let hasOwner = false
    try {
      staff = await getStaff(db, openid)
      hasOwner = (await countOwners()) > 0
    } catch (e) {
      if (!isMissingCollection(e)) throw e
      // 第一次运行，数据库还没有集合
      await ensureCollections(db)
    }
    return {
      staff: publicStaff(staff),
      hasOwner,
      ownerCodeRequired: !!process.env.OWNER_CODE
    }
  },

  // 店主绑定：店里还没有店主时，第一个绑定的人成为店主。
  // 如果在云函数环境变量里设置了 OWNER_CODE，还要输入这个绑定码。
  async bindOwner({ name, code }, openid) {
    await ensureCollections(db)
    if ((await countOwners()) > 0) throw new BizError('店主已经绑定过了')
    if (process.env.OWNER_CODE && String(code || '').trim() !== process.env.OWNER_CODE) {
      throw new BizError('绑定码不对')
    }
    const staffName = cleanText(name, 12) || '店主'
    await db.collection('staff').doc(openid).set({
      data: { name: staffName, role: 'owner', createdAt: db.serverDate(), updatedAt: db.serverDate() }
    })
    return publicStaff({ name: staffName, role: 'owner' })
  },

  // 员工用店主给的 6 位邀请码绑定
  async bindStaff({ name, code }, openid) {
    const inviteCode = String(code || '').trim()
    if (!/^\d{6}$/.test(inviteCode)) throw new BizError('请输入 6 位邀请码')
    const res = await db.collection('staff_invites')
      .where({ code: inviteCode, used: false, expiresAt: _.gt(Date.now()) })
      .limit(1)
      .get()
    const invite = res.data[0]
    if (!invite) throw new BizError('邀请码无效或已过期，请让店主重新生成')

    const existing = await getStaff(db, openid)
    if (existing && existing.role === 'owner' && invite.role !== 'owner') {
      throw new BizError('你已经是店主了，不用再绑定')
    }

    // 带条件更新，防止同一个邀请码被两个人同时用掉
    const claimed = await db.collection('staff_invites')
      .where({ _id: invite._id, used: false })
      .update({ data: { used: true, usedBy: openid, usedAt: db.serverDate() } })
    if (!claimed.stats.updated) throw new BizError('邀请码已经被用过了')

    const staffName = cleanText(name, 12) || (existing && existing.name) || ROLES[invite.role]
    await db.collection('staff').doc(openid).set({
      data: {
        name: staffName,
        role: invite.role,
        createdAt: existing && existing.createdAt ? existing.createdAt : db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    return publicStaff({ name: staffName, role: invite.role })
  },

  async listStaff(event, openid) {
    await requireRole(db, openid, ['owner'])
    const res = await db.collection('staff').orderBy('createdAt', 'asc').limit(100).get()
    return res.data.map((s) => Object.assign({ id: s._id, isMe: s._id === openid, webUsername: s.webUsername || '' }, publicStaff(s)))
  },

  // ---------- 店铺设置：微信支付 ----------

  async getShopSettings(event, openid) {
    await requireRole(db, openid, ['owner'])
    const res = await db.collection('settings').where({ _id: 'shop' }).limit(1).get()
    const s = res.data[0] || {}
    return { payEnabled: !!s.payEnabled, mchId: s.mchId || '', allowCounter: s.allowCounter !== false }
  },

  // 商户号要先在「云开发控制台 → 设置 → 其他设置 → 微信支付配置」里绑定
  async saveShopSettings({ payEnabled, mchId, allowCounter }, openid) {
    await requireRole(db, openid, ['owner'])
    const id = String(mchId || '').trim()
    if (id && !/^\d{8,12}$/.test(id)) throw new BizError('商户号是 8 到 12 位数字')
    if (payEnabled && !id) throw new BizError('打开微信支付前先填商户号')
    if (!payEnabled && allowCounter === false) throw new BizError('没开微信支付时，顾客只能到吧台付款')
    const data = { payEnabled: !!payEnabled, mchId: id, allowCounter: allowCounter !== false, updatedBy: openid, updatedAt: db.serverDate() }
    await db.collection('settings').doc('shop').set({ data })
    return { payEnabled: data.payEnabled, mchId: data.mchId, allowCounter: data.allowCounter }
  },

  // ---------- 电脑网页后台账号 ----------

  // 员工在小程序里给自己设网页后台的账号和密码
  async getWebAccount(event, openid) {
    const staff = await getStaff(db, openid)
    if (!staff) throw new BizError('只有店主和员工能开通网页后台', 'FORBIDDEN')
    return { username: staff.webUsername || '' }
  },

  async setWebAccount({ username, password }, openid) {
    const staff = await getStaff(db, openid)
    if (!staff) throw new BizError('只有店主和员工能开通网页后台', 'FORBIDDEN')
    const name = String(username || '').trim().toLowerCase()
    if (!USERNAME_RE.test(name)) throw new BizError('账号用 3 到 20 位小写字母、数字或下划线')
    const pwd = String(password || '')
    if (pwd.length < 8 || pwd.length > 64) throw new BizError('密码 8 到 64 位')
    if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) throw new BizError('密码要同时有字母和数字')
    const dup = await db.collection('staff').where({ webUsername: name }).limit(1).get()
    if (dup.data[0] && dup.data[0]._id !== openid) throw new BizError('这个账号已经有人用了，换一个')
    const salt = crypto.randomBytes(16).toString('hex')
    await db.collection('staff').doc(openid).update({
      data: {
        webUsername: name,
        web: { salt, hash: await hashPassword(pwd, salt), fails: 0, lockUntil: 0, updatedAt: Date.now() },
        updatedAt: db.serverDate()
      }
    })
    // 改密码后，之前在电脑上的登录全部失效
    await db.collection('web_sessions').where({ staffId: openid }).remove()
    return { username: name }
  },

  // 店主停用某位员工的网页后台，或者员工停用自己的
  async clearWebAccount({ id }, openid) {
    const target = id || openid
    if (target !== openid) await requireRole(db, openid, ['owner'])
    await db.collection('staff').doc(target).update({ data: { webUsername: '', web: _.set(null), updatedAt: db.serverDate() } })
    await db.collection('web_sessions').where({ staffId: target }).remove()
    return true
  },

  async webLogin({ username, password }) {
    const name = String(username || '').trim().toLowerCase()
    const wrong = new BizError('账号或密码不对')
    if (!USERNAME_RE.test(name) || typeof password !== 'string' || !password) throw wrong
    const res = await db.collection('staff').where({ webUsername: name }).limit(1).get()
    const staff = res.data[0]
    if (!staff || !staff.web || !staff.web.hash) throw wrong
    const now = Date.now()
    if (staff.web.lockUntil && staff.web.lockUntil > now) {
      throw new BizError('密码错太多次了，' + Math.ceil((staff.web.lockUntil - now) / 60000) + ' 分钟后再试')
    }
    const hash = await hashPassword(password.slice(0, 64), staff.web.salt)
    const same = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(staff.web.hash, 'hex'))
    if (!same) {
      const fails = (staff.web.fails || 0) + 1
      await db.collection('staff').doc(staff._id).update({
        data: { web: { fails: fails >= MAX_FAILS ? 0 : fails, lockUntil: fails >= MAX_FAILS ? now + LOCK_MS : 0 } }
      })
      throw wrong
    }
    if (staff.web.fails) await db.collection('staff').doc(staff._id).update({ data: { web: { fails: 0, lockUntil: 0 } } })
    return createSession(staff)
  },

  // ---------- 网页后台扫码登录 ----------
  // 网页拿到登录码 id（印在小程序码里）和只有这个网页知道的 key；员工用微信扫码在小程序里确认，网页再凭 key 换登录状态

  async createWebLogin() {
    const now = Date.now()
    // 顺手清掉一小时前的旧登录码
    await db.collection('web_login_tickets').where({ expiresAt: _.lt(now - 3600 * 1000) }).remove()
    const id = randomId(20)
    const key = crypto.randomBytes(32).toString('hex')
    let code
    try {
      code = await loginCode(id)
    } catch (e) {
      console.error('getUnlimited failed', e)
      throw new BizError('生成登录二维码失败：' + (e.errMsg || e.message || '未知错误'))
    }
    const expiresAt = now + LOGIN_TICKET_TTL
    await db.collection('web_login_tickets').add({
      data: { _id: id, keyHash: hashToken(key), status: 'waiting', staffId: '', envVersion: code.envVersion, expiresAt, createdAt: db.serverDate() }
    })
    const type = code.result.contentType || 'image/png'
    return { id, key, expiresAt, envVersion: code.envVersion, image: 'data:' + type + ';base64,' + Buffer.from(code.result.buffer).toString('base64') }
  },

  // 小程序确认页：看看这个登录码还能不能用
  async getWebLogin({ id }, openid) {
    const staff = await requireAnyStaff(openid)
    const ticket = await findTicket(id)
    return { status: ticketStatus(ticket), staff: publicStaff(staff) }
  },

  async confirmWebLogin({ id }, openid) {
    await requireAnyStaff(openid)
    const ticket = await findTicket(id)
    const gone = new BizError('二维码已经失效，请在电脑上刷新后再扫', 'TICKET_GONE')
    if (ticketStatus(ticket) !== 'waiting') throw gone
    const res = await db.collection('web_login_tickets')
      .where({ _id: ticket._id, status: 'waiting', expiresAt: _.gt(Date.now()) })
      .update({ data: { status: 'confirmed', staffId: openid, expiresAt: Date.now() + LOGIN_CONFIRM_TTL, confirmedAt: db.serverDate() } })
    if (!res.stats.updated) throw gone
    return true
  },

  async cancelWebLogin({ id }, openid) {
    await requireAnyStaff(openid)
    const ticket = await findTicket(id)
    await db.collection('web_login_tickets').where({ _id: ticket._id, status: 'waiting' }).update({ data: { status: 'cancelled' } })
    return true
  },

  // 网页每两秒问一次；确认过了就发登录状态，一个登录码只能换一次
  async pollWebLogin({ id, key }) {
    const ticket = await findTicket(id)
    const wrong = new BizError('登录码不对，请刷新二维码', 'TICKET_GONE')
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw wrong
    if (!crypto.timingSafeEqual(Buffer.from(hashToken(key), 'hex'), Buffer.from(ticket.keyHash, 'hex'))) throw wrong
    const status = ticketStatus(ticket)
    if (status !== 'confirmed') return { status }
    const res = await db.collection('web_login_tickets')
      .where({ _id: ticket._id, status: 'confirmed' })
      .update({ data: { status: 'used', usedAt: db.serverDate() } })
    if (!res.stats.updated) return { status: 'used' }
    const staff = await getStaff(db, ticket.staffId)
    if (!staff) return { status: 'cancelled' }
    return Object.assign({ status: 'ok' }, await createSession(staff))
  },

  async webLogout({ webToken }) {
    if (typeof webToken === 'string') await db.collection('web_sessions').where({ _id: hashToken(webToken) }).remove()
    return true
  },

  async createInvite({ role }, openid) {
    await requireRole(db, openid, ['owner'])
    if (!ROLES[role]) throw new BizError('请选择员工角色')
    let code = randomCode()
    for (let i = 0; i < 5; i++) {
      const dup = await db.collection('staff_invites')
        .where({ code, used: false, expiresAt: _.gt(Date.now()) })
        .count()
      if (!dup.total) break
      code = randomCode()
    }
    const expiresAt = Date.now() + INVITE_TTL
    await db.collection('staff_invites').add({
      data: { code, role, used: false, expiresAt, createdBy: openid, createdAt: db.serverDate() }
    })
    return { code, role, roleName: ROLES[role], expiresAt }
  },

  async updateStaff({ id, role }, openid) {
    await requireRole(db, openid, ['owner'])
    if (!ROLES[role]) throw new BizError('请选择员工角色')
    const target = await getStaff(db, id)
    if (!target) throw new BizError('找不到这位员工')
    if (target.role === 'owner' && role !== 'owner' && (await countOwners()) <= 1) {
      throw new BizError('至少要保留一位店主')
    }
    await db.collection('staff').doc(id).update({ data: { role, updatedAt: db.serverDate() } })
    return true
  },

  async removeStaff({ id }, openid) {
    await requireRole(db, openid, ['owner'])
    if (id === openid) throw new BizError('不能移除自己')
    await db.collection('staff').doc(id).remove()
    await db.collection('web_sessions').where({ staffId: id }).remove()
    return true
  }
}

exports.main = createMain(cloud, handlers, { anonymous: ['login', 'webLogin', 'webLogout', 'createWebLogin', 'pollWebLogin'] })
