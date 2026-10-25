// 本地预览网页后台用：用内存数据库和假的微信接口跑真正的服务器代码，不连微信、不存任何东西。
// 用法：npm run mock，然后打开 http://localhost:8787/admin/ ，账号 boss，密码 jinshan2026
const fs = require('fs')
const os = require('os')
const path = require('path')
const QRCode = require('qrcode')
const { createApp } = require('../../server/app')
const platform = require('../../server/platform')
const { Database } = require('../../server/lib/db')
const { createStorage } = require('../../server/lib/storage')
const { readJson, sendJson } = require('../../server/lib/http')
const seed = require('./seed')

const PORT = Number(process.env.PORT || 8787)

// 预览时没有真的小程序码，画一个普通二维码代替
const wechat = {
  ready: () => true,
  code2session: async (code) => ({ openid: 'MOCK_' + code }),
  getUnlimited: async (params) => ({
    buffer: await QRCode.toBuffer(params.page + '?scene=' + encodeURIComponent(params.scene), { width: 430, margin: 1 }),
    contentType: 'image/png'
  })
}
const pay = { mchId: '', ready: () => false }
const db = new Database(':memory:')
const storage = createStorage({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jinshan-mock-')) })

// 预览时没有手机，用店主的身份模拟扫码确认
async function extraRoutes(req, res, url) {
  if (req.method !== 'POST' || url.pathname !== '/mock/confirm-login') return false
  const { id } = await readJson(req, 4096)
  const result = await platform.runAs('OWNER', () => modules.common.main({ action: 'confirmWebLogin', id }))
  sendJson(res, 200, result)
  return true
}

const { server, modules } = createApp({
  config: { adminDir: path.join(__dirname, '..', process.argv[2] || 'dist-mock'), ownerCode: '' },
  db,
  wechat,
  pay,
  storage,
  extraRoutes
})

function as(openid) {
  const call = (fn) => (action, data) => platform.runAs(openid, () => fn.main(Object.assign({ action }, data || {})))
  return { common: call(modules.common), coffee: call(modules.coffee), book: call(modules.book) }
}

seed(as, db).then(() => {
  server.listen(PORT, () => console.log('网页后台预览：http://localhost:' + PORT + '/admin/  账号 boss  密码 jinshan2026'))
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
