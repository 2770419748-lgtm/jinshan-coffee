// 检查两个小程序的工程结构：页面文件齐全、JSON 能解析、WXML 标签成对、require 路径存在
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.join(__dirname, '..')
// 进山咖啡、黑镜洗车
const PROGRAMS = ['miniprogram', 'miniprogram-carwash']

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out)
    } else out.push(p)
  })
  return out
}

test('所有 JSON 文件都能解析', () => {
  walk(root).filter((f) => f.endsWith('.json') && f.indexOf('node_modules') === -1 && f.indexOf('.git' + path.sep) === -1)
    .forEach((f) => assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')), f))
})

const VOID = new Set(['input', 'image', 'switch', 'textarea', 'icon', 'progress', 'slider', 'checkbox', 'radio', 'wxs', 'import', 'include'])

PROGRAMS.forEach((name) => {
  const mp = path.join(root, name)
  const app = JSON.parse(fs.readFileSync(path.join(mp, 'app.json'), 'utf8'))
  const pages = app.pages.concat(...(app.subPackages || []).map((s) => s.pages.map((p) => s.root + '/' + p)))
  const subRoots = (app.subPackages || []).map((s) => s.root)

  test(name + '：app.json 里的每个页面都有 js/json/wxml/wxss', () => {
    pages.forEach((page) => {
      ;['.js', '.json', '.wxml', '.wxss'].forEach((ext) => {
        assert.ok(fs.existsSync(path.join(mp, page + ext)), page + ext + ' 不存在')
      })
    })
  })

  test(name + '：tabBar 页面和图标都存在', () => {
    app.tabBar.list.forEach((t) => {
      assert.ok(app.pages.indexOf(t.pagePath) !== -1, t.pagePath + ' 不在 pages 里')
      assert.ok(fs.existsSync(path.join(mp, t.iconPath)))
      assert.ok(fs.existsSync(path.join(mp, t.selectedIconPath)))
    })
  })

  test(name + '：WXML 标签成对、花括号成对', () => {
    walk(mp).filter((f) => f.endsWith('.wxml')).forEach((f) => {
      const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
      const opens = (src.match(/\{\{/g) || []).length
      const closes = (src.match(/\}\}/g) || []).length
      assert.equal(opens, closes, f + ' 的 {{ }} 不成对')
      const stack = []
      const re = /<(\/?)([a-zA-Z-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
      let m
      while ((m = re.exec(src))) {
        const [, closing, tag, , selfClose] = m
        if (selfClose || (!closing && VOID.has(tag) && tag !== 'textarea')) continue
        if (!closing && tag === 'textarea') { continue }
        if (closing) {
          const top = stack.pop()
          assert.equal(top, tag, f + ' 里 </' + tag + '> 对不上 <' + top + '>')
        } else stack.push(tag)
      }
      assert.deepEqual(stack, [], f + ' 有没闭合的标签：' + stack.join(','))
    })
  })

  test(name + '：页面 JS 里 require 的相对路径都存在；wxs 引用存在', () => {
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

  test(name + '：页面里绑定的事件在 JS 里都有对应方法', () => {
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

  // WXML 里只能调 WXS 模块（f.xxx）的函数，不能直接调数组、字符串的方法
  test(name + '：WXML 里不直接调数组、字符串的方法', () => {
    walk(mp).filter((f) => f.endsWith('.wxml')).forEach((f) => {
      ;(fs.readFileSync(f, 'utf8').match(/\{\{[^}]*\}\}/g) || []).forEach((e) => {
        const rest = e.replace(/(^|[^\w.])[a-z]\.[a-zA-Z]+\(/g, '$1')
        assert.ok(!/\.(join|map|filter|indexOf|find|slice|toFixed|replace)\(/.test(rest), f + ' 里直接调了方法：' + e)
      })
    })
  })

  test(name + '：JS 和 WXS 没有语法错误', () => {
    walk(mp).filter((f) => /\.(js|wxs)$/.test(f)).forEach((f) => {
      assert.doesNotThrow(() => new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }), f)
    })
  })

  test(name + '：主包里的资源不引用分包（小程序不允许）', () => {
    const inSub = (f) => subRoots.some((r) => f.startsWith(path.join(mp, r) + path.sep))
    walk(mp).filter((f) => !inSub(f) && /\.(js|wxml)$/.test(f)).forEach((f) => {
      const src = fs.readFileSync(f, 'utf8')
      subRoots.forEach((r) => {
        const bad = src.match(new RegExp('require\\([\'"][^\'"]*' + r + '/'))
        assert.ok(!bad, f + ' 在主包里 require 了分包文件')
      })
    })
  })
})

// 洗车小程序登录时要告诉服务器是哪个小程序，服务器才会用洗车的 AppID 换 openid
test('miniprogram-carwash：登录带上 app: carwash，AppID 还是占位', () => {
  const api = fs.readFileSync(path.join(root, 'miniprogram-carwash/utils/api.js'), 'utf8')
  assert.match(api, /request\('\/api\/login', \{ code, app: 'carwash' \}\)/)
  const project = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram-carwash/project.config.json'), 'utf8'))
  const coffee = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  assert.notEqual(project.appid, coffee.appid, '洗车和咖啡是两个小程序，AppID 不能一样')
})
