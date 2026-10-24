// 检查小程序工程结构：页面文件齐全、JSON 能解析、WXML 标签成对、require 路径存在
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mp = path.join(root, 'miniprogram')
const app = JSON.parse(fs.readFileSync(path.join(mp, 'app.json'), 'utf8'))

const pages = app.pages.concat(...(app.subPackages || []).map((s) => s.pages.map((p) => s.root + '/' + p)))

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out)
    } else out.push(p)
  })
  return out
}

test('app.json 里的每个页面都有 js/json/wxml/wxss', () => {
  pages.forEach((page) => {
    ;['.js', '.json', '.wxml', '.wxss'].forEach((ext) => {
      assert.ok(fs.existsSync(path.join(mp, page + ext)), page + ext + ' 不存在')
    })
  })
})

test('tabBar 页面和图标都存在', () => {
  app.tabBar.list.forEach((t) => {
    assert.ok(app.pages.indexOf(t.pagePath) !== -1, t.pagePath + ' 不在 pages 里')
    assert.ok(fs.existsSync(path.join(mp, t.iconPath)))
    assert.ok(fs.existsSync(path.join(mp, t.selectedIconPath)))
  })
})

test('所有 JSON 文件都能解析', () => {
  walk(root).filter((f) => f.endsWith('.json') && f.indexOf('node_modules') === -1 && f.indexOf('.git' + path.sep) === -1)
    .forEach((f) => assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')), f))
})

const VOID = new Set(['input', 'image', 'switch', 'textarea', 'icon', 'progress', 'slider', 'checkbox', 'radio', 'wxs', 'import', 'include'])

test('WXML 标签成对、花括号成对', () => {
  walk(mp).filter((f) => f.endsWith('.wxml')).forEach((f) => {
    const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const opens = (src.match(/\{\{/g) || []).length
    const closes = (src.match(/\}\}/g) || []).length
    assert.equal(opens, closes, f + ' 的 {{ }} 不成对')
    const stack = []
    const re = /<(\/?)([a-zA-Z-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
    let m
    while ((m = re.exec(src))) {
      const [, closing, name, , selfClose] = m
      if (selfClose || (!closing && VOID.has(name) && name !== 'textarea')) continue
      if (!closing && name === 'textarea') { continue }
      if (closing) {
        const top = stack.pop()
        assert.equal(top, name, f + ' 里 </' + name + '> 对不上 <' + top + '>')
      } else stack.push(name)
    }
    assert.deepEqual(stack, [], f + ' 有没闭合的标签：' + stack.join(','))
  })
})

test('页面 JS 里 require 的相对路径都存在；wxs 引用存在', () => {
  walk(mp).filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fs.readFileSync(f, 'utf8')
    const re = /require\(['"](\.[^'"]+)['"]\)/g
    let m
    while ((m = re.exec(src))) {
      const target = path.resolve(path.dirname(f), m[1])
      assert.ok(fs.existsSync(target) || fs.existsSync(target + '.js'), f + ' 引用的 ' + m[1] + ' 不存在')
    }
  })
  walk(mp).filter((f) => f.endsWith('.wxml')).forEach((f) => {
    const src = fs.readFileSync(f, 'utf8')
    const re = /<wxs src="([^"]+)"/g
    let m
    while ((m = re.exec(src))) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), m[1])), f + ' 引用的 ' + m[1] + ' 不存在')
    }
  })
})

test('页面里绑定的事件在 JS 里都有对应方法', () => {
  pages.forEach((page) => {
    const wxml = fs.readFileSync(path.join(mp, page + '.wxml'), 'utf8')
    const js = fs.readFileSync(path.join(mp, page + '.js'), 'utf8')
    const re = /(?:bind|catch)(?:tap|input|change|touchmove)="([a-zA-Z]+)"/g
    let m
    while ((m = re.exec(wxml))) {
      assert.match(js, new RegExp('\\n  ' + m[1] + '\\('), page + ' 缺少方法 ' + m[1])
    }
  })
})

test('主包里的资源不引用分包（小程序不允许）', () => {
  walk(mp).filter((f) => !f.startsWith(path.join(mp, 'admin')) && /\.(js|wxml)$/.test(f)).forEach((f) => {
    const src = fs.readFileSync(f, 'utf8')
    const bad = src.match(/require\(['"][^'"]*admin\//)
    assert.ok(!bad, f + ' 在主包里 require 了分包文件')
  })
})
