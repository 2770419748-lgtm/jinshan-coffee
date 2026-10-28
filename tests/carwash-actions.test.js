// 洗车小程序和网页后台洗车页面调用的接口，服务器上都要有（防止前端写错名字、后端改名漏改）
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { modules } = require('./helpers/load')

const root = path.join(__dirname, '..')

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  })
  return out
}

// 从源码里找 { 模块: [操作名] }
function usedActions(files) {
  const used = { carwash: new Set(), common: new Set() }
  files.forEach((f) => {
    const src = fs.readFileSync(f, 'utf8')
    let m
    const direct = /api\.(carwash|common)\('([a-zA-Z]+)'/g
    while ((m = direct.exec(src))) used[m[1]].add(m[2])
    // utils/pay.js：run('payOrder', {...}, 'confirmPay')、balance('payWithBalance', ...)
    const viaPay = /(?:run|balance)\('([a-zA-Z]+)'(?:, \{[^}]*\}, '([a-zA-Z]+)')?/g
    while ((m = viaPay.exec(src))) {
      used.carwash.add(m[1])
      if (m[2]) used.carwash.add(m[2])
    }
    // 网页后台储值和次卡页：OPS 里的接口名
    const ops = /(?:flag|sort|remove): '([a-zA-Z]+)'/g
    while ((m = ops.exec(src))) used.carwash.add(m[1])
  })
  return used
}

async function check(files) {
  const used = usedActions(files)
  assert.ok(used.carwash.size > 10, '没找到接口调用，检查一下正则')
  for (const name of Object.keys(used)) {
    for (const action of used[name]) {
      const res = await modules[name].main({ action })
      assert.notEqual(res.code, 'UNKNOWN_ACTION', name + '.' + action + ' 服务器上没有')
    }
  }
}

test('洗车小程序调用的接口服务器上都有', () => {
  const dir = path.join(root, 'miniprogram-carwash')
  return check(walk(dir).filter((f) => f.endsWith('.js')))
})

test('网页后台洗车页面调用的接口服务器上都有', () => {
  const dir = path.join(root, 'admin-web', 'src', 'views')
  return check(walk(dir).filter((f) => /Carwash\w*\.vue$/.test(f)))
})
