// 本地预览网页后台用：用内存数据库跑真正的云函数代码，不连云开发。
// 用法：npm run mock，然后打开 http://localhost:8787 ，账号 boss，密码 jinshan2026
const http = require('http')
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const { cloud, as } = require('../../tests/helpers/load')

// 预览时没有真的小程序码，画一个普通二维码代替
cloud.openapi.wxacode.getUnlimited = async (params) => ({
  buffer: await QRCode.toBuffer(params.page + '?scene=' + encodeURIComponent(params.scene), { width: 430, margin: 1 }),
  contentType: 'image/png'
})

const PORT = Number(process.env.PORT || 8787)
const ROOT = path.join(__dirname, '..', process.argv[2] || 'dist-mock')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }

async function seed() {
  const ok = async (p) => {
    const res = await p
    if (!res.ok) throw new Error(res.msg)
    return res.data
  }
  const owner = as('OWNER')
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.common('setWebAccount', { username: 'boss', password: 'jinshan2026' }))
  for (const [id, role, name] of [['BARISTA', 'barista', '小王'], ['KEEPER', 'book_manager', '小李']]) {
    const invite = await ok(owner.common('createInvite', { role }))
    await ok(as(id).common('bindStaff', { name, code: invite.code }))
  }
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
  for (const no of ['1', '2', '3', '5', 'A1']) await ok(owner.coffee('saveTable', { tableNo: no }))
  const menu = await ok(owner.coffee('getMenu'))
  const byName = (n) => menu.products.find((p) => p.name === n)
  const cup = [{ name: '杯型', option: '大杯' }, { name: '温度', option: '冰' }]
  const customers = ['C1', 'C2', 'C3', 'C4'].map(as)
  const o1 = await ok(customers[0].coffee('createOrder', { mode: 'dine_in', tableNo: '5', remark: '少冰', items: [{ productId: byName('拿铁')._id, qty: 2, specs: cup }, { productId: byName('芝士蛋糕')._id, qty: 1 }] }))
  await ok(customers[1].coffee('createOrder', { mode: 'takeaway', items: [{ productId: byName('手冲')._id, qty: 1 }] }))
  const o3 = await ok(customers[2].coffee('createOrder', { mode: 'dine_in', tableNo: 'A1', items: [{ productId: byName('美式')._id, qty: 1, specs: [{ name: '杯型', option: '中杯' }, { name: '温度', option: '热' }] }] }))
  await ok(owner.coffee('markPaid', { id: o1.id }))
  await ok(owner.coffee('markPaid', { id: o3.id }))
  await ok(owner.coffee('setOrderStatus', { id: o3.id, status: 'making' }))
  const shelf = await ok(owner.book('getShelf'))
  const hourly = shelf.rules.find((r) => r.type === 'hourly')
  const day = shelf.rules.find((r) => r.type === 'day')
  const r1 = await ok(customers[0].book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 2 }))
  await ok(owner.book('markRentalPaid', { id: r1.id }))
  await ok(owner.book('handOut', { id: r1.id }))
  cloud.__db.collections.book_rentals[r1.id].dueAt = new Date(Date.now() - 25 * 60000)
  const r2 = await ok(customers[3].book('createRental', { bookId: shelf.books[2]._id, ruleId: day._id }))
  await ok(owner.book('markRentalPaid', { id: r2.id }))
  await ok(customers[1].book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 1, remark: '靠窗位' }))
}

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

seed().then(() => {
  server.listen(PORT, () => console.log('网页后台预览：http://localhost:' + PORT + '  账号 boss  密码 jinshan2026'))
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
