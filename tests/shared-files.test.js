const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

test('两个云函数里的 lib/base.js 内容一致', () => {
  const root = path.join(__dirname, '..', 'cloudfunctions')
  const a = fs.readFileSync(path.join(root, 'common', 'lib', 'base.js'), 'utf8')
  const b = fs.readFileSync(path.join(root, 'coffee', 'lib', 'base.js'), 'utf8')
  assert.equal(a, b, '改了一份 base.js 记得复制到另一个云函数')
})
