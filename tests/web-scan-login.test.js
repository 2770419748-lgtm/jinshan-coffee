// 网页后台扫码登录：网页拿登录码，员工在小程序里确认，网页凭 key 换登录状态
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc, setDoc } = require('./helpers/load')

const owner = as('OWNER')
const barista = as('BARISTA')
const alice = as('ALICE')
const anon = as('')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

test('准备：店主和咖啡师', async () => {
  db.reset()
  await ok(owner.common('bindOwner', { name: '坤总' }))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { name: '小王', code: invite.code }))
})

test('网页拿到小程序码，扫码确认后登录', async () => {
  const t = await ok(anon.common('createWebLogin'))
  assert.match(t.id, /^[A-Za-z0-9]{20}$/)
  assert.match(t.key, /^[0-9a-f]{64}$/)
  assert.match(t.image, /^data:image\/png;base64,/)
  assert.equal(t.envVersion, 'release')
  assert.deepEqual(
    { scene: state.lastCodeParams.scene, page: state.lastCodeParams.page, checkPath: state.lastCodeParams.checkPath },
    { scene: 'w=' + t.id, page: 'admin/pages/web-login/web-login', checkPath: true }
  )
  assert.ok(state.lastCodeParams.scene.length <= 32, 'scene 最多 32 个字符')
  assert.notEqual((await getDoc('web_login_tickets', t.id)).keyHash, t.key, '数据库里只存 key 的哈希')

  assert.deepEqual(await ok(anon.common('pollWebLogin', { id: t.id, key: t.key })), { status: 'waiting' })

  // 顾客扫了也确认不了
  await fails(alice.common('getWebLogin', { id: t.id }), 'FORBIDDEN')
  await fails(alice.common('confirmWebLogin', { id: t.id }), 'FORBIDDEN')

  const info = await ok(barista.common('getWebLogin', { id: t.id }))
  assert.equal(info.status, 'waiting')
  assert.equal(info.staff.name, '小王')
  await ok(barista.common('confirmWebLogin', { id: t.id }))
  await fails(owner.common('confirmWebLogin', { id: t.id }), 'TICKET_GONE')

  // 不知道 key 的人拿不走登录状态
  await fails(anon.common('pollWebLogin', { id: t.id, key: '0'.repeat(64) }), 'TICKET_GONE')
  await fails(anon.common('pollWebLogin', { id: t.id }), 'TICKET_GONE')

  const res = await ok(anon.common('pollWebLogin', { id: t.id, key: t.key }))
  assert.equal(res.status, 'ok')
  assert.equal(res.staff.role, 'barista')
  assert.match(res.token, /^[0-9a-f]{64}$/)
  const me = await ok(anon.common('login', { webToken: res.token }))
  assert.equal(me.staff.name, '小王')
  // 角色权限照旧：咖啡师进不了每日汇总
  await fails(anon.coffee('daySummary', { webToken: res.token }), 'FORBIDDEN')

  // 一个码只能换一次
  assert.deepEqual(await ok(anon.common('pollWebLogin', { id: t.id, key: t.key })), { status: 'used' })
})

test('手机上取消、过期的码都登录不了', async () => {
  const a = await ok(anon.common('createWebLogin'))
  await ok(owner.common('cancelWebLogin', { id: a.id }))
  assert.deepEqual(await ok(anon.common('pollWebLogin', { id: a.id, key: a.key })), { status: 'cancelled' })
  await fails(owner.common('confirmWebLogin', { id: a.id }), 'TICKET_GONE')

  const b = await ok(anon.common('createWebLogin'))
  await setDoc('web_login_tickets', b.id, { expiresAt: Date.now() - 1 })
  assert.equal((await ok(owner.common('getWebLogin', { id: b.id }))).status, 'expired')
  await fails(owner.common('confirmWebLogin', { id: b.id }), 'TICKET_GONE')
  assert.deepEqual(await ok(anon.common('pollWebLogin', { id: b.id, key: b.key })), { status: 'expired' })

  // 确认后网页一直没来取，也会过期
  const c = await ok(anon.common('createWebLogin'))
  await ok(owner.common('confirmWebLogin', { id: c.id }))
  await setDoc('web_login_tickets', c.id, { expiresAt: Date.now() - 1 })
  assert.deepEqual(await ok(anon.common('pollWebLogin', { id: c.id, key: c.key })), { status: 'expired' })

  await fails(owner.common('getWebLogin', { id: 'nope' }), 'TICKET_GONE')
  await fails(anon.common('pollWebLogin', { id: '../../x', key: a.key }), 'TICKET_GONE')
})

test('确认后员工被移除，网页拿不到登录状态', async () => {
  const invite = await ok(owner.common('createInvite', { role: 'book_manager' }))
  const keeper = as('KEEPER')
  await ok(keeper.common('bindStaff', { name: '小李', code: invite.code }))
  const t = await ok(anon.common('createWebLogin'))
  await ok(keeper.common('confirmWebLogin', { id: t.id }))
  await ok(owner.common('removeStaff', { id: 'KEEPER' }))
  assert.deepEqual(await ok(anon.common('pollWebLogin', { id: t.id, key: t.key })), { status: 'cancelled' })
})

test('小程序还没发布时自动改用体验版码', async () => {
  state.unreleased = true
  const t = await ok(anon.common('createWebLogin'))
  state.unreleased = false
  assert.equal(t.envVersion, 'trial')
  assert.equal(state.lastCodeParams.envVersion, 'trial')
  assert.equal(state.lastCodeParams.checkPath, false)
})

test('一小时前的旧登录码会被清掉', async () => {
  const old = await ok(anon.common('createWebLogin'))
  await setDoc('web_login_tickets', old.id, { expiresAt: Date.now() - 2 * 3600 * 1000 })
  await ok(anon.common('createWebLogin'))
  assert.equal(await getDoc('web_login_tickets', old.id), null)
})
