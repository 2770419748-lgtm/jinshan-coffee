// 顾客的地址簿：咖啡外送（coffee_addresses）和洗车上门（cw_addresses）各存各的，写法一样。
// 位置在小程序里用腾讯地图选（wx.chooseLocation），和店里设置的坐标是同一套，算距离准。
const { BizError, isMissingCollection, cleanText } = require('./base')

const MAX_ADDRESSES = 20
const PHONE_RE = /^(1\d{10}|0\d{2,3}-?\d{7,8})$/

function cleanAddress(a) {
  const name = cleanText(a.name, 10)
  if (!name) throw new BizError('请填联系人')
  const phone = String(a.phone || '').trim()
  if (!PHONE_RE.test(phone)) throw new BizError('联系电话格式不对')
  const place = cleanText(a.place, 60)
  if (!place) throw new BizError('请在地图上选位置')
  const lat = Number(a.location && a.location.lat)
  const lng = Number(a.location && a.location.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new BizError('请在地图上选位置')
  return {
    name,
    phone,
    place,
    detail: cleanText(a.detail, 40),
    location: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 },
    isDefault: !!a.isDefault
  }
}

function publicAddress(a) {
  return { _id: a._id, name: a.name, phone: a.phone, place: a.place, detail: a.detail || '', location: a.location, isDefault: !!a.isDefault }
}

// name：集合名。返回查地址的方法和给小程序用的三个操作（列表、保存、删除）
function createAddressBook(db, name) {
  const _ = db.command
  const col = () => db.collection(name)

  async function list(openid) {
    try {
      return (await col().where({ _openid: openid }).orderBy('updatedAt', 'desc').limit(MAX_ADDRESSES).get()).data
    } catch (e) {
      if (isMissingCollection(e)) return []
      throw e
    }
  }

  async function find(openid, id) {
    if (!id) return null
    const res = await col().where({ _id: String(id), _openid: openid }).limit(1).get()
    return res.data[0] || null
  }

  // 没指定时用默认地址，没有默认的用最近改过的
  async function pick(openid, id) {
    if (id) return find(openid, id)
    const all = await list(openid)
    return all.find((a) => a.isDefault) || all[0] || null
  }

  const handlers = {
    async listAddresses(event, openid) {
      return (await list(openid)).map(publicAddress)
    },

    async saveAddress({ address }, openid) {
      const a = address || {}
      const data = cleanAddress(a)
      data.updatedAt = db.serverDate()
      let id = a._id ? String(a._id) : ''
      if (id) {
        const res = await col().where({ _id: id, _openid: openid }).update({ data })
        if (!res.stats.updated) throw new BizError('这个地址不存在了')
      } else {
        const count = (await col().where({ _openid: openid }).count()).total
        if (count >= MAX_ADDRESSES) throw new BizError('地址最多存 ' + MAX_ADDRESSES + ' 个，先删掉一些不用的')
        if (!count) data.isDefault = true
        data._openid = openid
        data.createdAt = db.serverDate()
        id = (await col().add({ data }))._id
      }
      // 只有一个默认地址
      if (data.isDefault) await col().where({ _openid: openid, _id: _.neq(id), isDefault: true }).update({ data: { isDefault: false } })
      return { id }
    },

    async deleteAddress({ id }, openid) {
      await col().where({ _id: String(id || ''), _openid: openid }).remove()
      return true
    }
  }

  return { list, find, pick, handlers }
}

module.exports = { MAX_ADDRESSES, PHONE_RE, cleanAddress, publicAddress, createAddressBook }
