// 在线预览：在浏览器里跑真正的云函数代码和内存数据库，假数据和 mock 服务器一样，刷新页面就重置
const QRCode = require('qrcode')
const { Buffer } = require('buffer')
const cloud = require('wx-server-sdk') // 打包时指向 tests/helpers/fake-cloud.js
const seed = require('../mock/seed')

const functions = {
  common: require('../../cloudfunctions/common/index.js'),
  coffee: require('../../cloudfunctions/coffee/index.js'),
  book: require('../../cloudfunctions/book/index.js')
}

// 没有真的小程序码，画一个普通二维码（SVG，不用 canvas）代替
cloud.openapi.wxacode.getUnlimited = async (params) => {
  const svg = await QRCode.toString(params.page + '?scene=' + encodeURIComponent(params.scene), { type: 'svg', margin: 1 })
  return { buffer: Buffer.from(svg), contentType: 'image/svg+xml' }
}

// 云函数是按顺序跑的（openid 放在共享状态里），这里排队调用
let queue = Promise.resolve()
function run(openid, name, data) {
  const task = queue.then(() => {
    cloud.__state.openid = openid
    return functions[name].main(data)
  })
  queue = task.catch(() => {})
  return task
}

function as(openid) {
  const call = (name) => (action, data) => run(openid, name, Object.assign({ action }, data || {}))
  return { common: call('common'), coffee: call('coffee'), book: call('book') }
}

const ready = seed(cloud, as)

module.exports = {
  async call(name, data) {
    await ready
    if (!functions[name]) return { ok: false, msg: '没有这个云函数' }
    return run('', name, data)
  },
  async confirmLogin(id) {
    await ready
    return as('OWNER').common('confirmWebLogin', { id })
  }
}
