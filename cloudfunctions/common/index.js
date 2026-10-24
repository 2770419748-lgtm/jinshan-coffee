// 公共云函数：登录、店主绑定、员工邀请和权限管理
const crypto = require('crypto')
const cloud = require('wx-server-sdk')
const {
  ROLES,
  BizError,
  isMissingCollection,
  cleanText,
  ensureCollections,
  getStaff,
  requireRole,
  publicStaff,
  createMain
} = require('./lib/base')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const INVITE_TTL = 24 * 3600 * 1000

async function countOwners() {
  const res = await db.collection('staff').where({ role: 'owner' }).count()
  return res.total
}

function randomCode() {
  return String(100000 + (crypto.randomBytes(4).readUInt32BE(0) % 900000))
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
    return res.data.map((s) => Object.assign({ id: s._id, isMe: s._id === openid }, publicStaff(s)))
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
    return true
  }
}

exports.main = createMain(cloud, handlers)
