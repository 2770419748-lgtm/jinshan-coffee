// 网页后台扫码登录：小程序码的 scene 是 w=登录码（20 位字母数字）；测试服务器发的码后面再带 &s=t
const ID_RE = /^[A-Za-z0-9]{20}$/

function sceneText(scene) {
  return scene ? decodeURIComponent(String(scene)) : ''
}

function fromScene(scene) {
  const m = sceneText(scene).match(/(?:^|&)w=([A-Za-z0-9]{20})(?:&|$)/)
  return m ? m[1] : ''
}

// 页面 query：微信扫码打开是 { scene: 'w%3D...' }，小程序里扫码跳过来是 { id: '...', s: 't' }
function parseQuery(query) {
  if (!query) return ''
  if (query.id && ID_RE.test(String(query.id))) return String(query.id)
  return fromScene(query.scene)
}

// 登录码是哪台服务器发的：'test' 或 'prod'
function parseServer(query) {
  if (!query) return 'prod'
  if (query.s === 't') return 'test'
  return /(?:^|&)s=t(?:&|$)/.test(sceneText(query.scene)) ? 'test' : 'prod'
}

// wx.scanCode 扫小程序码得到的 path，例如 admin/pages/web-login/web-login?scene=w%3D...
function pathQuery(path) {
  const query = {}
  const i = String(path || '').indexOf('?')
  if (i === -1) return query
  String(path).slice(i + 1).split('&').forEach((pair) => {
    const [k, v] = pair.split('=')
    if (k) query[k] = v || ''
  })
  return query
}

function parsePath(path) {
  return fromScene(pathQuery(path).scene)
}

function parsePathServer(path) {
  return parseServer({ scene: pathQuery(path).scene })
}

module.exports = { parseQuery, parseServer, parsePath, parsePathServer }
