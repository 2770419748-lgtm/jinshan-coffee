// 进山咖啡的服务器：小程序和电脑网页后台都调这里。
// 启动：node app.js（读同目录的 config.json，照着 config.example.json 填；也可以用环境变量 JINSHAN_CONFIG 指定别的路径）
//
//   POST /api/login                 小程序 wx.login 的 code 换登录状态
//   POST /api/common|coffee|book    调业务模块，body 是 { action, ...参数 }
//   POST /api/upload                员工上传图片
//   POST /pay/notify/coffee|book    微信支付通知
//   GET  /uploads/...               图片
//   GET  /admin/                    电脑网页后台
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const platform = require('./platform')
const { Database } = require('./lib/db')
const { createWechat } = require('./lib/wechat')
const { createWxpay } = require('./lib/wxpay')
const { createStorage } = require('./lib/storage')
const { HttpError, readBody, readJson, firstFile, sendJson, sendFile } = require('./lib/http')

const MAX_JSON = 5 * 1024 * 1024
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_NOTIFY = 64 * 1024
// 小程序登录状态 30 天，过期了小程序会自动重新登录
const MP_SESSION_TTL = 30 * 24 * 3600 * 1000
const MODULES = ['common', 'coffee', 'book']
const PAY_MODULES = ['coffee', 'book']
const BACKUP_KEEP_DAYS = 14

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

function loadConfig(file) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('找不到配置文件 ' + file + '：把 config.example.json 复制一份改名为 config.json，再填上内容')
    throw new Error('配置文件 ' + file + ' 格式不对：' + e.message)
  }
  const dir = path.dirname(path.resolve(file))
  const abs = (p, fallback) => path.resolve(dir, p || fallback)
  const pay = raw.pay || {}
  return {
    port: Number(raw.port || 3000),
    host: raw.host || '127.0.0.1',
    publicUrl: String(raw.publicUrl || '').replace(/\/+$/, ''),
    appId: String(raw.appId || ''),
    appSecret: String(raw.appSecret || ''),
    ownerCode: String(raw.ownerCode || ''),
    dataDir: abs(raw.dataDir, 'data'),
    uploadDir: abs(raw.uploadDir, path.join(raw.dataDir || 'data', 'uploads')),
    adminDir: abs(raw.adminDir, '../admin-web/dist'),
    pay: {
      mchId: String(pay.mchId || ''),
      serialNo: String(pay.serialNo || ''),
      privateKeyFile: pay.privateKeyFile ? abs(pay.privateKeyFile) : '',
      apiV3Key: String(pay.apiV3Key || ''),
      publicKeyFile: pay.publicKeyFile ? abs(pay.publicKeyFile) : '',
      publicKeyId: String(pay.publicKeyId || '')
    }
  }
}

function readKey(file) {
  if (!file) return ''
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    console.error('读不到密钥文件 ' + file + '：' + e.message)
    return ''
  }
}

// 装好各部分，返回 http 服务器。extraRoutes(req, res, url) 返回 true 表示已经处理（本地预览用）
function createApp({ config, db, wechat, pay, storage, extraRoutes }) {
  platform.configure({ db, wechat, pay, storage })
  if (config.ownerCode) process.env.OWNER_CODE = config.ownerCode
  const modules = {}
  MODULES.forEach((name) => { modules[name] = require('./functions/' + name) })
  const { getStaff, resolveWebToken } = require('./functions/base')

  async function sessionOpenid(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return ''
    const res = await db.collection('mp_sessions').where({ _id: hash(token) }).limit(1).get()
    const s = res.data[0]
    return s && s.expiresAt > Date.now() ? s.openid : ''
  }

  async function login(req, res) {
    const { code } = await readJson(req, 4096)
    if (typeof code !== 'string' || !code || code.length > 128) return sendJson(res, 400, { ok: false, msg: '登录参数不对', code: 'BAD_REQUEST' })
    let openid
    try {
      openid = (await wechat.code2session(code)).openid
    } catch (e) {
      console.error('code2session failed', e.message)
      return sendJson(res, 200, { ok: false, msg: '微信登录失败，请稍后再试', code: 'WX_LOGIN_FAILED' })
    }
    const now = Date.now()
    await db.collection('mp_sessions').where({ expiresAt: db.command.lt(now) }).remove()
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = now + MP_SESSION_TTL
    await db.collection('mp_sessions').add({ data: { _id: hash(token), openid, expiresAt, createdAt: db.serverDate() } })
    sendJson(res, 200, { ok: true, data: { token, expiresAt } })
  }

  async function callModule(name, req, res) {
    const body = await readJson(req, MAX_JSON)
    if (typeof body.action !== 'string' || !body.action) return sendJson(res, 400, { ok: false, msg: '未知操作', code: 'UNKNOWN_ACTION' })
    let openid = ''
    if (req.headers['x-session']) {
      openid = await sessionOpenid(req.headers['x-session'])
      if (!openid) return sendJson(res, 200, { ok: false, msg: '登录过期了', code: 'NEED_WX_LOGIN' })
    }
    const result = await platform.runAs(openid, () => modules[name].main(body))
    sendJson(res, 200, result)
  }

  // 只有员工能传图：小程序里靠登录状态，网页后台靠 webToken
  async function upload(req, res, url) {
    let openid = ''
    if (req.headers['x-session']) openid = await sessionOpenid(req.headers['x-session'])
    else if (req.headers['x-web-token']) openid = await resolveWebToken(db, String(req.headers['x-web-token'])).catch(() => '')
    if (!openid || !(await getStaff(db, openid))) return sendJson(res, 200, { ok: false, msg: '只有店主和员工能上传图片', code: 'FORBIDDEN' })
    let buf
    try {
      buf = await readBody(req, MAX_IMAGE + 64 * 1024)
    } catch (e) {
      if (e.status === 413) return sendJson(res, 200, { ok: false, msg: '图片太大了，换一张 5MB 以内的', code: 'TOO_LARGE' })
      throw e
    }
    const type = String(req.headers['content-type'] || '')
    const file = /multipart\/form-data/i.test(type) ? firstFile(buf, type) : buf
    if (!file || !file.length) return sendJson(res, 200, { ok: false, msg: '没收到图片', code: 'BAD_REQUEST' })
    if (file.length > MAX_IMAGE) return sendJson(res, 200, { ok: false, msg: '图片太大了，换一张 5MB 以内的', code: 'TOO_LARGE' })
    let fileID
    try {
      fileID = storage.saveImage(file, url.searchParams.get('folder') || '')
    } catch (e) {
      return sendJson(res, 200, { ok: false, msg: '只能上传 jpg、png、gif、webp 图片', code: 'BAD_IMAGE' })
    }
    sendJson(res, 200, { ok: true, data: { fileID } })
  }

  // 微信支付通知：解密后交给对应模块；处理失败回 500，微信会过一会儿再通知
  async function payNotify(name, req, res) {
    const raw = await readBody(req, MAX_NOTIFY)
    let note
    try {
      note = pay.parseNotify(req.headers, raw)
    } catch (e) {
      console.error('pay notify rejected', e.message)
      return sendJson(res, 400, { code: 'FAIL', message: 'bad notify' })
    }
    try {
      if (note.eventType === 'TRANSACTION.SUCCESS' && note.tradeState === 'SUCCESS') {
        await modules[name].onPayNotify({ outTradeNo: note.outTradeNo })
      }
    } catch (e) {
      console.error('pay notify failed', note.outTradeNo, e)
      return sendJson(res, 500, { code: 'FAIL', message: 'retry' })
    }
    res.writeHead(204)
    res.end()
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    res.setHeader('x-content-type-options', 'nosniff')
    if (extraRoutes && (await extraRoutes(req, res, url))) return
    if (req.method === 'POST') {
      if (p === '/api/login') return login(req, res)
      if (p === '/api/upload') return upload(req, res, url)
      const m = /^\/api\/([a-z]+)$/.exec(p)
      if (m && MODULES.indexOf(m[1]) !== -1) return callModule(m[1], req, res)
      const n = /^\/pay\/notify\/([a-z]+)$/.exec(p)
      if (n && PAY_MODULES.indexOf(n[1]) !== -1) return payNotify(n[1], req, res)
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/healthz') return sendJson(res, 200, { ok: true })
      if (p === '/' || p === '/admin') {
        res.writeHead(302, { location: '/admin/' })
        return res.end()
      }
      if (p.indexOf('/uploads/') === 0) {
        const file = storage.resolve(decodeURIComponent(p))
        if (file && sendFile(req, res, storage.root, path.relative(storage.root, file), 'public, max-age=31536000, immutable')) return
      }
      if (p.indexOf('/admin/') === 0) {
        const rel = decodeURIComponent(p.slice('/admin/'.length)) || 'index.html'
        // 打包出来的文件名带哈希，可以长期缓存；index.html 和 config.js 每次都要新的
        const cache = /^assets\//.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache'
        if (sendFile(req, res, config.adminDir, rel, cache)) return
      }
    }
    sendJson(res, 404, { ok: false, msg: 'not found', code: 'NOT_FOUND' })
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof HttpError) return sendJson(res, e.status, { ok: false, msg: e.message, code: 'BAD_REQUEST' })
      console.error('[' + req.method + ' ' + req.url + ']', e)
      if (!res.headersSent) sendJson(res, 500, { ok: false, msg: '服务器开小差了，请稍后再试', code: 'SERVER_ERROR' })
      else res.end()
    })
  })
  return { server, modules }
}

// 每天凌晨 4 点以后备份一次数据库到 data/backups，保留 14 天
function scheduleBackups(db, dataDir) {
  const dir = path.join(dataDir, 'backups')
  const run = () => {
    try {
      const cn = new Date(Date.now() + 8 * 3600 * 1000)
      if (cn.getUTCHours() < 4) return
      const day = cn.toISOString().slice(0, 10)
      const file = path.join(dir, 'jinshan-' + day + '.db')
      fs.mkdirSync(dir, { recursive: true })
      if (!fs.existsSync(file)) {
        db.backupTo(file)
        console.log('数据库已备份：' + file)
      }
      const cutoff = new Date(cn.getTime() - BACKUP_KEEP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
      fs.readdirSync(dir).forEach((f) => {
        const m = /^jinshan-(\d{4}-\d{2}-\d{2})\.db$/.exec(f)
        if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f))
      })
    } catch (e) {
      console.error('数据库备份失败', e)
    }
  }
  setTimeout(run, 60 * 1000).unref()
  setInterval(run, 3600 * 1000).unref()
}

function main() {
  const config = loadConfig(process.env.JINSHAN_CONFIG || path.join(__dirname, 'config.json'))
  fs.mkdirSync(config.dataDir, { recursive: true })
  const db = new Database(path.join(config.dataDir, 'jinshan.db'))
  const wechat = createWechat({ appId: config.appId, appSecret: config.appSecret })
  // 还没填商户号时不去读证书，免得日志里报找不到文件
  const payKey = (file) => (config.pay.mchId ? readKey(file) : '')
  const pay = createWxpay({
    appId: config.appId,
    mchId: config.pay.mchId,
    serialNo: config.pay.serialNo,
    privateKey: payKey(config.pay.privateKeyFile),
    apiV3Key: config.pay.apiV3Key,
    publicKey: payKey(config.pay.publicKeyFile),
    publicKeyId: config.pay.publicKeyId,
    notifyBase: config.publicUrl
  })
  const storage = createStorage({ dir: config.uploadDir })
  const { server, modules } = createApp({ config, db, wechat, pay, storage })
  if (!wechat.ready()) console.warn('注意：配置文件里还没填 appId / appSecret，小程序登录和小程序码用不了')
  console.log(pay.ready() ? '微信支付已配置，商户号 ' + config.pay.mchId : '微信支付没配置（商户号下来以后按 README 填配置）')
  scheduleBackups(db, config.dataDir)
  // 每分钟取消一次超时没付款的预约单
  setInterval(() => {
    modules.coffee.expireReservations().catch((e) => console.error('取消超时预约单失败', e))
  }, 60 * 1000).unref()
  server.listen(config.port, config.host, () => {
    console.log('进山咖啡服务器已启动：http://' + config.host + ':' + config.port + '  数据目录 ' + config.dataDir)
  })
  const stop = () => server.close(() => {
    db.close()
    process.exit(0)
  })
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (require.main === module) main()

module.exports = { createApp, loadConfig, scheduleBackups }
