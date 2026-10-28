// 测试版服务器（config.json 里 env 是 test）：数据从正式版复制来，不收真钱、只给店员发通知、扫码登录用体验版、网页后台标「测试版」
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const platform = require('../server/platform')
const { createApp, loadConfig } = require('../server/app')
const { Database } = require('../server/lib/db')
const { createStorage } = require('../server/lib/storage')
const { db, state, as, unwrap, getDoc } = require('./helpers/load')

const ok = (p) => unwrap(p)
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))
const PICKUP = { priTmplId: 'TPL_PICKUP', title: '取餐提醒', type: 2, content: '取餐号:{{character_string1.DATA}}\n温馨提示:{{thing2.DATA}}\n' }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jinshan-testenv-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('配置：env 填 test 才是测试版，别的都当正式版', () => {
  const file = path.join(tmp, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ env: 'test', port: 3001 }))
  assert.equal(loadConfig(file).env, 'test')
  fs.writeFileSync(file, JSON.stringify({ env: 'staging' }))
  assert.equal(loadConfig(file).env, 'prod')
  fs.writeFileSync(file, '{}')
  assert.equal(loadConfig(file).env, 'prod')
})

// 下面用业务模块直接测，数据库是内存里的
const owner = as('OWNER')
const barista = as('BARISTA')
const alice = as('ALICE')
const anon = as('')

test('准备：切到测试版，店主、咖啡师、菜单、取餐通知模板', async () => {
  platform.configure({ env: 'test' })
  assert.equal(platform.isTest(), true)
  db.reset()
  state.payReady = false
  state.templates = [PICKUP]
  state.sent = []
  state.sendError = 0
  await ok(owner.common('bindOwner', { name: '坤总' }))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: invite.code, name: '小林' }))
  await ok(owner.coffee('seedDemo'))
  await ok(owner.common('saveNotifySettings', { orderReady: 'TPL_PICKUP', state: 'formal' }))
})

test('取餐通知：测试版只发给店主和店员，不发给顾客；点开的是体验版', async () => {
  const menu = await ok(alice.coffee('getMenu'))
  const cake = menu.products.find((p) => p.name === '芝士蛋糕')
  const make = (who) => ok(who.coffee('createOrder', { mode: 'takeaway', items: [{ productId: cake._id, qty: 1 }], subscribed: true }))
  const fromCustomer = await make(alice)
  const fromOwner = await make(owner)
  for (const { id } of [fromCustomer, fromOwner]) {
    await ok(barista.coffee('setOrderStatus', { id, status: 'making' }))
    await ok(barista.coffee('setOrderStatus', { id, status: 'done' }))
  }
  await flush()
  assert.deepEqual(state.sent.map((m) => m.touser), ['OWNER'], '真顾客（从正式版复制来的数据里的人）收不到')
  assert.equal(state.sent[0].miniprogramState, 'trial', '正式版的设置在测试版里换成体验版')
  assert.equal((await getDoc('coffee_orders', fromCustomer.id)).status, 'done', '不发通知不影响出餐')
})

test('扫码登录：测试版直接出体验版的码，scene 里带 s=t', async () => {
  state.unreleased = false
  const t = await ok(anon.common('createWebLogin'))
  assert.equal(t.envVersion, 'trial')
  assert.equal(state.lastCodeParams.envVersion, 'trial')
  assert.equal(state.lastCodeParams.checkPath, false)
  assert.equal(state.lastCodeParams.scene, 'w=' + t.id + '&s=t')
  assert.ok(state.lastCodeParams.scene.length <= 32, 'scene 最多 32 个字符')

  platform.configure({ env: 'prod' })
  const p = await ok(anon.common('createWebLogin'))
  assert.equal(p.envVersion, 'release', '正式版照旧先出正式版的码')
  assert.equal(state.lastCodeParams.scene, 'w=' + p.id)
})

// 放在最后：createApp 会把 platform 换成自己的数据库
test('网页后台：测试版页面顶上有「测试版」，标题也带上；健康检查报 env', async () => {
  const adminDir = path.join(tmp, 'admin')
  fs.mkdirSync(path.join(adminDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html><html><head><title>进山管理后台</title></head><body><div id="app"></div></body></html>')
  fs.writeFileSync(path.join(adminDir, 'assets', 'app.js'), 'console.log(1)')
  const wechat = { ready: () => true }
  const pay = { mchId: '', ready: () => false }
  const run = async (env, fn) => {
    const { server } = createApp({
      config: { env, adminDir }, db: new Database(':memory:'), wechat, pay, storage: createStorage({ dir: path.join(tmp, 'up') })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      await fn('http://127.0.0.1:' + server.address().port)
    } finally {
      server.close()
    }
  }
  await run('test', async (base) => {
    assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, env: 'test' })
    for (const p of ['/admin/', '/admin/index.html']) {
      const res = await fetch(base + p)
      const html = await res.text()
      assert.equal(res.headers.get('cache-control'), 'no-cache')
      assert.match(html, /<title>【测试版】进山管理后台<\/title>/)
      assert.match(html, /<body><div style="[^"]*">测试版/)
      assert.match(html, /<div id="app"><\/div>/)
    }
    assert.equal(await (await fetch(base + '/admin/assets/app.js')).text(), 'console.log(1)', '别的文件原样给')
  })
  await run('prod', async (base) => {
    assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, env: 'prod' })
    assert.doesNotMatch(await (await fetch(base + '/admin/')).text(), /测试版/)
  })
})
