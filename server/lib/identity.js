// 两个小程序认同一个人：同一个微信号在咖啡、洗车小程序里的 openid 不一样，unionid 一样
// （前提是两个小程序都绑在同一个微信开放平台账号下，没绑的话微信不给 unionid）。
// 业务数据都按「用户 id」存（会员、订单、券、员工）。一个 unionid 第一次出现时，用当时那个小程序的 openid 当用户 id，
// 记在 wx_users 里，以后不管从哪个小程序进来都认这个 id。没有 unionid 时用户 id 就是 openid，两个小程序各算各的人。
//
// 注意：开放平台绑定之前就在咖啡小程序里有记录的人，绑定后要先打开一次咖啡小程序，再打开洗车小程序，
// 这样用户 id 才会沿用咖啡那边原来的 openid，原来的余额、订单都还在。

const APPS = ['coffee', 'carwash']

// 返回用户 id；app 是 coffee 或 carwash
async function resolveUser(db, app, openid, unionid) {
  if (!openid) throw new Error('missing openid')
  if (!unionid) return openid
  const col = db.collection('wx_users')
  const find = async () => (await col.where({ _id: unionid }).limit(1).get()).data[0] || null
  const found = await find()
  if (found) {
    if (!found.openids || found.openids[app] !== openid) {
      await col.doc(unionid).update({ data: { openids: { [app]: openid }, updatedAt: new Date() } })
    }
    return found.uid
  }
  try {
    await col.add({ data: { _id: unionid, uid: openid, openids: { [app]: openid }, createdAt: new Date(), updatedAt: new Date() } })
    return openid
  } catch (e) {
    // 同一个人同时打开了两个小程序，另一边已经记上了
    const again = await find()
    if (again) return again.uid
    throw e
  }
}

module.exports = { APPS, resolveUser }
