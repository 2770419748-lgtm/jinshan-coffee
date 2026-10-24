const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

test('每个云函数里的 lib/base.js 内容一致', () => {
  const root = path.join(__dirname, '..', 'cloudfunctions')
  const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'lib', 'base.js')))
  assert.ok(dirs.length >= 3, '至少 common、coffee、book 三个云函数')
  const first = fs.readFileSync(path.join(root, 'common', 'lib', 'base.js'), 'utf8')
  dirs.forEach((d) => {
    const text = fs.readFileSync(path.join(root, d, 'lib', 'base.js'), 'utf8')
    assert.equal(text, first, d + '/lib/base.js 和 common 的不一样，改了一份记得复制到其他云函数')
  })
})

test('每个云函数都有 package.json 和 config.json，依赖同一个版本的 wx-server-sdk', () => {
  const root = path.join(__dirname, '..', 'cloudfunctions')
  fs.readdirSync(root).forEach((d) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, d, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['wx-server-sdk'], '~3.0.4', d)
    assert.ok(fs.existsSync(path.join(root, d, 'config.json')), d + ' 缺 config.json')
  })
})
