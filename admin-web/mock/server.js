// 本地预览网页后台用：用内存数据库跑真正的云函数代码，不连云开发。
// 用法：npm run mock，然后打开 http://localhost:8787 ，账号 boss，密码 jinshan2026
const http = require('http')
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const { cloud, as } = require('../../tests/helpers/load')
const seed = require('./seed')

// 预览时没有真的小程序码，画一个普通二维码代替
cloud.openapi.wxacode.getUnlimited = async (params) => ({
  buffer: await QRCode.toBuffer(params.page + '?scene=' + encodeURIComponent(params.scene), { width: 430, margin: 1 }),
  contentType: 'image/png'
})

const PORT = Number(process.env.PORT || 8787)
const ROOT = path.join(__dirname, '..', process.argv[2] || 'dist-mock')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(e)
      }
    })
  })
}

async function handle(req, res, run) {
  try {
    const result = await run(await readJson(req))
    send(res, 200, 'application/json', JSON.stringify(result))
  } catch (e) {
    send(res, 500, 'application/json', JSON.stringify({ ok: false, msg: e.message }))
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/mock/call')) {
    return handle(req, res, async ({ name, data }) => {
      const fn = as('')[name]
      if (!fn) return { ok: false, msg: '没有这个云函数' }
      return fn(data.action, data)
    })
  }
  // 预览时没有手机，用店主的身份模拟扫码确认
  if (req.method === 'POST' && req.url.endsWith('/mock/confirm-login')) {
    return handle(req, res, ({ id }) => as('OWNER').common('confirmWebLogin', { id }))
  }
  const url = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(ROOT, url === '/' ? 'index.html' : url)
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'text/plain', 'not found')
  send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file))
})

seed(cloud, as).then(() => {
  server.listen(PORT, () => console.log('网页后台预览：http://localhost:' + PORT + '  账号 boss  密码 jinshan2026'))
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
