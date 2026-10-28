// 网页后台扫码登录：小程序码的 scene 是 w=登录码（20 位字母数字）
const ID_RE = /^[A-Za-z0-9]{20}$/

function fromScene(scene) {
  if (!scene) return ''
  const text = decodeURIComponent(String(scene))
  const m = text.match(/(?:^|&)w=([A-Za-z0-9]{20})(?:&|$)/)
  return m ? m[1] : ''
}

// 页面 query：微信扫码打开是 { scene: 'w%3D...' }，小程序里扫码跳过来是 { id: '...' }
function parseQuery(query) {
  if (!query) return ''
  if (query.id && ID_RE.test(String(query.id))) return String(query.id)
  return fromScene(query.scene)
}

// wx.scanCode 扫小程序码得到的 path，例如 admin/pages/web-login/web-login?scene=w%3D...
function parsePath(path) {
  if (!path) return ''
  const i = String(path).indexOf('?')
  if (i === -1) return ''
  const query = {}
  String(path).slice(i + 1).split('&').forEach((pair) => {
    const [k, v] = pair.split('=')
    if (k) query[k] = v || ''
  })
  return fromScene(query.scene)
}

module.exports = { parseQuery, parsePath }
