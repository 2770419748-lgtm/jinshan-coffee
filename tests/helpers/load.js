// 让云函数里的 require('wx-server-sdk') 指向测试替身，然后加载云函数
const Module = require('module')
const path = require('path')

const fakePath = path.join(__dirname, 'fake-cloud.js')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'wx-server-sdk') return fakePath
  return originalResolve.call(this, request, ...rest)
}

const cloud = require(fakePath)
const root = path.join(__dirname, '..', '..', 'cloudfunctions')
const common = require(path.join(root, 'common', 'index.js'))
const coffee = require(path.join(root, 'coffee', 'index.js'))

// 以某个用户身份调用云函数
function as(openid) {
  const call = (fn) => async (action, data) => {
    cloud.__state.openid = openid
    return fn.main(Object.assign({ action }, data || {}))
  }
  return { common: call(common), coffee: call(coffee) }
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

module.exports = { cloud, as, unwrap }
