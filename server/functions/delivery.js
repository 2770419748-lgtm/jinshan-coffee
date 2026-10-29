// 外送（配送到家）的设置：settings 集合里 _id 为 delivery 的那条。
// 起送价、配送范围、配送费、预计多久送到这些数都由店主在后台填，代码里不给默认值；没填齐之前外送不开放，后台会列出还差哪几项。
// 配送费、距离、能不能送，也在这里算；距离按直线算（和洗车上门一样，坐标用腾讯地图的）。
const { BizError, isMissingCollection, cleanText } = require('./base')
const { readShop, hoursOf } = require('./shop')
const pay = require('./pay')
const wallet = require('./wallet')
const couriers = require('./couriers')

const SETTINGS_ID = 'delivery'
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const PHONE_RE = /^(1\d{10}|0\d{2,3}-?\d{7,8})$/
const CN_OFFSET = 8 * 3600 * 1000
const MAX_FEE = 100000 // 1000 元
// 店员自己送；微信同城配送（顺丰同城、达达等）。以后接别家时在 couriers.js 里加一个，再加到这里
const PROVIDERS = ['self', 'wechat']
// 微信同城配送一单只发给一家配送公司：price 价格优先（比价后发给便宜的），prefer 优先用指定的那家
const WECHAT_PATTERNS = ['price', 'prefer']
const WECHAT_CARRIERS = ['SFTC', 'DADA']

async function readRaw(db) {
  try {
    const res = await db.collection('settings').where({ _id: SETTINGS_ID }).limit(1).get()
    return res.data[0] || {}
  } catch (e) {
    if (isMissingCollection(e)) return {}
    throw e
  }
}

function minutesOf(hhmm) {
  const m = HHMM_RE.exec(hhmm || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const STORE_FIELDS = ['name', 'province', 'city', 'area', 'street', 'house', 'phone']

function normalize(s) {
  const store = {}
  STORE_FIELDS.forEach((k) => { store[k] = (s.store && typeof s.store[k] === 'string' && s.store[k]) || '' })
  return {
    enabled: !!s.enabled,
    location: s.location && Number.isFinite(s.location.lat) && Number.isFinite(s.location.lng) ? { lat: s.location.lat, lng: s.location.lng } : null,
    store,
    hours: s.hours && minutesOf(s.hours.open) !== null && minutesOf(s.hours.close) !== null ? { open: s.hours.open, close: s.hours.close } : null,
    radiusKm: numOrNull(s.radiusKm),
    minOrder: intOrNull(s.minOrder),
    baseFee: intOrNull(s.baseFee),
    baseKm: numOrNull(s.baseKm),
    perKmFee: intOrNull(s.perKmFee),
    freeAbove: intOrNull(s.freeAbove),
    etaMinutes: intOrNull(s.etaMinutes),
    notice: s.notice || '',
    provider: PROVIDERS.indexOf(s.provider) !== -1 ? s.provider : 'self',
    autoCall: !!s.autoCall,
    wechatPattern: WECHAT_PATTERNS.indexOf(s.wechatPattern) !== -1 ? s.wechatPattern : 'price',
    wechatPrefer: WECHAT_CARRIERS.indexOf(s.wechatPrefer) !== -1 ? s.wechatPrefer : '',
    // 在微信同城配送开通的门店（后台点「开通门店」时自动填）
    wechatStoreId: s.wechatStoreId || '',
    wechatStoreAt: s.wechatStoreAt || null
  }
}

async function readSettings(db) {
  return normalize(await readRaw(db))
}

function feeField(value, label) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > MAX_FEE) throw new BizError(label + '请填 0 到 ' + MAX_FEE / 100 + ' 元')
  return n
}

function kmField(value, label, min) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > 50) throw new BizError(label + '请填 ' + min + ' 到 50 公里')
  return Math.round(n * 10) / 10
}

// 后台保存：检查格式，返回要存的内容（不检查填没填齐，那个看 problems）。wechatStoreId 不从这里改
function cleanSettings(input) {
  const s = input || {}
  let hours = null
  if (s.hours && (s.hours.open || s.hours.close)) {
    const open = minutesOf(s.hours.open)
    const close = minutesOf(s.hours.close)
    if (open === null || close === null) throw new BizError('外送时间格式不对，例如 10:00')
    if (close <= open) throw new BizError('外送结束时间要晚于开始时间')
    hours = { open: s.hours.open, close: s.hours.close }
  }
  let location = null
  if (s.location && s.location.lat !== '' && s.location.lat !== undefined && s.location.lat !== null) {
    const lat = Number(s.location.lat)
    const lng = Number(s.location.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new BizError('店的位置（经纬度）不对')
    location = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }
  }
  const st = s.store || {}
  const store = {
    name: cleanText(st.name, 20),
    province: cleanText(st.province, 10),
    city: cleanText(st.city, 10),
    area: cleanText(st.area, 10),
    street: cleanText(st.street, 20),
    house: cleanText(st.house, 40),
    phone: cleanText(st.phone, 20)
  }
  if (store.phone && !PHONE_RE.test(store.phone)) throw new BizError('店里电话格式不对，手机号或者带区号的座机，比如 0832-1234567')
  const eta = s.etaMinutes === undefined || s.etaMinutes === null || s.etaMinutes === '' ? null : Number(s.etaMinutes)
  if (eta !== null && (!Number.isInteger(eta) || eta < 5 || eta > 240)) throw new BizError('预计送达请填 5 到 240 分钟')
  if (s.provider !== undefined && PROVIDERS.indexOf(s.provider) === -1) throw new BizError('配送方式选项不对')
  const pattern = s.wechatPattern || 'price'
  if (WECHAT_PATTERNS.indexOf(pattern) === -1) throw new BizError('派单方式选项不对')
  const prefer = s.wechatPrefer || ''
  if (prefer && WECHAT_CARRIERS.indexOf(prefer) === -1) throw new BizError('优先用的配送公司选项不对')
  if (pattern === 'prefer' && !prefer) throw new BizError('选了「优先用指定的配送公司」，请选是哪一家')
  return {
    enabled: !!s.enabled,
    location,
    store,
    hours,
    radiusKm: kmField(s.radiusKm, '配送范围', 0.1),
    minOrder: feeField(s.minOrder, '起送价'),
    baseFee: feeField(s.baseFee, '配送费'),
    baseKm: kmField(s.baseKm, '起步距离', 0),
    perKmFee: feeField(s.perKmFee, '超出每公里加收'),
    freeAbove: feeField(s.freeAbove, '满多少免配送费'),
    etaMinutes: eta,
    notice: cleanText(s.notice, 200),
    provider: s.provider || 'self',
    autoCall: !!s.autoCall,
    wechatPattern: pattern,
    wechatPrefer: prefer
  }
}

// 开放外送前还差哪几项没填。ways：{ online } 店里能不能在线收钱（微信支付或会员余额）；
// courierReady：选了第三方配送时，服务器上的密钥配好没有
function problems(s, ways, courierReady) {
  const list = []
  if (!s.location) list.push('店的位置（算距离用）')
  if (s.radiusKm === null) list.push('配送范围')
  if (s.minOrder === null) list.push('起送价（不限填 0）')
  if (s.baseFee === null) list.push('配送费（不收填 0）')
  if (s.perKmFee > 0 && s.baseKm === null) list.push('起步距离（超出部分才按公里加收）')
  if (!ways.online) list.push('在线收款：外送要先付款，先打开微信支付或会员储值')
  if (s.provider === 'wechat') {
    if (!courierReady) list.push('服务器上还没配置微信同城配送的密钥')
    else if (!s.wechatStoreId) list.push('在微信同城配送开通门店（下面「微信同城配送」里点开通）')
  }
  return list
}

// 外送现在的情况：设置、还差哪几项、开没开放（open）、现在在不在外送时间（inHours）、外送时间
// 外送要先在线付款：开通了微信支付，或者开了会员储值（用余额付）才能开
async function readState(db) {
  const [settings, shop, paySettings, walletSettings] = await Promise.all([readSettings(db), readShop(db), pay.getSettings(db), wallet.readSettings(db)])
  const list = problems(settings, { online: !!(paySettings.payEnabled || walletSettings.enabled) }, couriers.adapterOf(settings.provider).ready())
  const hours = hoursFor(settings, shop)
  return { settings, problems: list, open: settings.enabled && !list.length, hours, inHours: inHours(hours) }
}

// 外送时间：没单独设就跟营业时间一样
function hoursFor(s, shop) {
  return s.hours || hoursOf(shop)
}

// 现在能不能下外送单（只看时间）
function inHours(hours, now) {
  const t = (now === undefined ? Date.now() : now) + CN_OFFSET
  const d = new Date(t)
  const m = d.getUTCHours() * 60 + d.getUTCMinutes()
  return m >= minutesOf(hours.open) && m < minutesOf(hours.close)
}

// 两个经纬度之间的直线距离（公里，保留一位小数）
function distanceKm(a, b) {
  const rad = (x) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 10) / 10
}

// 配送费：起步距离内收 baseFee，超出部分每公里（不足 1 公里按 1 公里）加 perKmFee；商品满 freeAbove 免配送费
function feeFor(s, km, goodsTotal) {
  if (s.freeAbove > 0 && goodsTotal >= s.freeAbove) return 0
  let fee = s.baseFee || 0
  if (s.perKmFee > 0 && s.baseKm !== null) {
    const extraTenths = Math.round(km * 10) - Math.round(s.baseKm * 10)
    if (extraTenths > 0) fee += Math.ceil(extraTenths / 10) * s.perKmFee
  }
  return fee
}

// 送这个地址：{ distanceKm, fee }；超出范围、地址没定位时抛错
function charge(s, where, goodsTotal) {
  if (!s.location || !where || !Number.isFinite(where.lat) || !Number.isFinite(where.lng)) {
    throw new BizError('这个地址没有定位，请编辑地址重新在地图上选一下', 'ADDRESS_NO_LOCATION')
  }
  const km = distanceKm(s.location, where)
  if (km > s.radiusKm) {
    throw new BizError('这个地址离店 ' + km + ' 公里，超出了外送范围（' + s.radiusKm + ' 公里），换个地址或者到店自取', 'OUT_OF_RANGE')
  }
  return { distanceKm: km, fee: feeFor(s, km, goodsTotal) }
}

// 顾客端看的规则：起送价、配送费怎么算、预计多久
function publicRules(s, hours) {
  return {
    minOrder: s.minOrder || 0,
    baseFee: s.baseFee || 0,
    baseKm: s.baseKm,
    perKmFee: s.perKmFee || 0,
    freeAbove: s.freeAbove || 0,
    radiusKm: s.radiusKm,
    etaMinutes: s.etaMinutes,
    notice: s.notice,
    hours,
    phone: s.store.phone
  }
}

module.exports = {
  SETTINGS_ID,
  PROVIDERS,
  WECHAT_CARRIERS,
  PHONE_RE,
  readSettings,
  readState,
  cleanSettings,
  problems,
  hoursFor,
  inHours,
  distanceKm,
  feeFor,
  charge,
  publicRules
}
