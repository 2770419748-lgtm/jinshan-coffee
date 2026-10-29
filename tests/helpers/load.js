// 测试环境：内存里的 SQLite 数据库 + 微信接口替身，加载真正的业务模块
const path = require('path')
const platform = require('../../server/platform')
const { Database } = require('../../server/lib/db')
const fakes = require('./fakes')

const db = new Database(':memory:')
platform.configure({
  db,
  wechat: fakes.wechat,
  pay: fakes.pay,
  storage: fakes.storage,
  carwash: { wechat: fakes.carwashWechat, pay: fakes.carwashPay },
  couriers: { wechat: fakes.courier }
})

const root = path.join(__dirname, '..', '..', 'server', 'functions')
const common = require(path.join(root, 'common.js'))
const coffee = require(path.join(root, 'coffee.js'))
const book = require(path.join(root, 'book.js'))
const member = require(path.join(root, 'member.js'))
const carwash = require(path.join(root, 'carwash.js'))

// 以某个用户身份调用业务模块；openid 为空相当于电脑网页后台或没登录。
// extra：{ app, appOpenid } 表示从哪个小程序来的（不传就是不分小程序，付款用 openid）
function as(openid, extra) {
  const call = (fn) => (action, data) => platform.runAs(openid, () => fn.main(Object.assign({ action }, data || {})), extra)
  return { common: call(common), coffee: call(coffee), book: call(book), member: call(member), carwash: call(carwash) }
}

// 成功时返回 data，失败时抛出带 code 的错误，方便断言
function unwrap(promise) {
  return promise.then((res) => {
    if (!res.ok) {
      const err = new Error(res.msg)
      err.code = res.code
      throw err
    }
    return res.data
  })
}

// 直接读写数据库里的一条记录（测试里改时间、看存了什么）
async function getDoc(collection, id) {
  const res = await db.collection(collection).where({ _id: id }).limit(1).get()
  return res.data[0] || null
}

function setDoc(collection, id, data) {
  return db.collection(collection).doc(id).update({ data })
}

const cloud = { __db: db, __state: fakes.state }

module.exports = { cloud, db, state: fakes.state, as, unwrap, getDoc, setDoc, courierStatus: fakes.courierStatus, modules: { common, coffee, book, member, carwash } }
