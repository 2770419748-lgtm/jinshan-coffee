// 当前用户的员工身份（店主、洗车店长、技师），每次进入相关页面时刷新
const api = require('./api')

let cache = null

function getUser(force) {
  if (cache && !force) return Promise.resolve(cache)
  return api.common('login').then((data) => {
    cache = data
    return data
  })
}

function clearUser() {
  cache = null
}

module.exports = { getUser, clearUser }
