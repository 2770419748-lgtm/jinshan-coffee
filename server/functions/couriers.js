// 配送方式的适配器：店员自己送（self）、微信同城配送（wechat，一个接口叫顺丰同城、达达）。
// 每个适配器做同样几件事：估运费 quote、叫骑手 create、查进度 query、取消 cancel，沙箱里还能模拟骑手状态 mock。
// 进度统一成 STATUS_TEXT 里这几种，记在订单的 delivery.status 上。以后接达达开放平台等，照 wechat 的样子再加一个。
const cloud = require('../platform')
const { BizError } = require('./base')
const { appOpenid } = require('../lib/identity')

const STATUS_TEXT = {
  waiting: '待配送', // 还没叫骑手
  calling: '等骑手接单',
  accepted: '骑手已接单',
  arrived: '骑手已到店',
  delivering: '配送中',
  delivered: '已送达',
  cancelled: '配送已取消',
  abnormal: '配送异常'
}
// 第三方还在送的状态：服务器每分钟查一次进度
const LIVE = ['calling', 'accepted', 'arrived', 'delivering', 'abnormal']

// 微信同城配送的订单状态
const WX_STATUS = {
  10000: 'calling', // 订单创建成功，等骑手接单
  20000: 'cancelled', // 商家取消
  20001: 'cancelled', // 配送方取消
  30000: 'accepted',
  40000: 'arrived',
  50000: 'delivering',
  60000: 'calling', // 骑手撤单，等别的骑手接
  70000: 'delivered',
  90000: 'abnormal'
}
const WX_NOTE = { 20001: '配送公司取消了这单', 60000: '骑手撤单了，正在等别的骑手接单', 90000: '配送异常，请联系骑手或配送公司' }
const WX_CARRIERS = { SFTC: '顺丰同城', DADA: '达达', SS: '闪送', MTPS: '美团配送', UUPT: 'UU跑腿', FENGNIAO: '蜂鸟' }
// 物品类型：饮料
const WX_CARGO_DRINK = 32
// 每件按 400 克估重量，骑手接单时参考
const ITEM_GRAMS = 400

function carrierName(id) {
  return WX_CARRIERS[id] || id || ''
}

function wxApi() {
  return cloud.courierOf('wechat')
}

// 微信接口报错时给店员看的话
function wxFail(e, what) {
  console.error('同城配送' + what + '失败', e.errCode, e.errMsg || e.message)
  return new BizError(what + '失败：' + (e.errMsg || e.message || '请稍后再试') + (e.errCode ? '（' + e.errCode + '）' : ''), 'COURIER_FAILED')
}

function cargoOf(order) {
  const num = (order.items || []).reduce((n, l) => n + l.qty, 0) || 1
  const first = (order.items || [])[0]
  return {
    cargo_name: Array.from(((first && first.name) || '咖啡') + (num > 1 ? '等' + num + '件' : '')).slice(0, 20).join(''),
    cargo_weight: num * ITEM_GRAMS,
    cargo_price: order.totalFee,
    cargo_type: WX_CARGO_DRINK,
    cargo_num: num
  }
}

// 微信同城配送：同一单重新叫骑手时要换一个门店订单号，否则微信会把上次那单原样返回
function wxOrderNo(order, attempt) {
  return order.orderNo + (attempt > 1 ? '-' + attempt : '')
}

function receiver(order) {
  const a = order.delivery.address
  return {
    user_name: a.name,
    user_phone: a.phone,
    user_lat: a.location.lat,
    user_lng: a.location.lng,
    user_address: (a.place + ' ' + (a.detail || '')).trim()
  }
}

// 查单、回调里的骑手信息：字段名两种写法都认
function riderOf(data) {
  const t = data.transporter_info || data.rider_info || {}
  const name = t.transporter_name || t.name || ''
  const phone = t.transporter_phone || t.phone || ''
  return name || phone ? { name: String(name), phone: String(phone) } : null
}

const wechat = {
  key: 'wechat',
  name: '微信同城配送',
  external: true,

  ready() {
    return wxApi().ready()
  },

  sandbox() {
    return !!wxApi().sandbox
  },

  // 估运费：{ fee, distanceM, carrier, carrierName }
  async quote({ settings, order }) {
    let data
    try {
      data = await wxApi().preAddOrder(Object.assign({
        wx_store_id: settings.wechatStoreId,
        cargo: cargoOf(order)
      }, receiver(order), this.sandbox() ? { use_sandbox: 1 } : {}))
    } catch (e) {
      throw wxFail(e, '估运费')
    }
    // 有的版本返回一个列表，挑最便宜的
    const list = Array.isArray(data.trans_list) ? data.trans_list.filter((t) => !t.errcode) : [data]
    const best = list.map((t) => ({ carrier: t.service_trans_id || '', fee: Number(t.est_fee !== undefined ? t.est_fee : t.price) || 0, distanceM: Number(t.distance) || 0 }))
      .sort((a, b) => a.fee - b.fee)[0]
    if (!best) throw new BizError('附近暂时没有能接单的骑手', 'COURIER_FAILED')
    return Object.assign(best, { carrierName: carrierName(best.carrier) })
  },

  // 叫骑手：返回要记到订单 delivery 上的字段
  async create({ settings, order, db }) {
    const attempt = (order.delivery.attempts || 0) + 1
    const storeOrderId = wxOrderNo(order, attempt)
    const body = Object.assign({
      wx_store_id: settings.wechatStoreId,
      store_order_id: storeOrderId,
      user_openid: await appOpenid(db, 'coffee', order._openid),
      order_seq: order.pickupNo,
      verify_code_type: 0,
      order_detail_path: 'pages/order-detail/order-detail?id=' + order._id,
      cargo: cargoOf(order)
    }, receiver(order))
    const notifyUrl = wxApi().notifyUrl
    if (notifyUrl) body.callback_url = notifyUrl
    if (this.sandbox()) body.use_sandbox = 1
    let data
    try {
      data = await wxApi().addOrder(body)
    } catch (e) {
      throw wxFail(e, '叫骑手')
    }
    return {
      status: 'calling',
      attempts: attempt,
      storeOrderId,
      courierOrderId: String(data.wx_order_id || ''),
      carrier: String(data.service_trans_id || ''),
      carrierName: carrierName(data.service_trans_id),
      waybillId: String(data.waybill_id || data.trans_order_id || ''),
      courierFee: Number(data.fee) || 0,
      fetchCode: String(data.fetch_code || ''),
      sandbox: this.sandbox()
    }
  },

  // 查进度：{ status, note, rider, courierFee, deductFee, carrier, carrierName }
  async query({ settings, order }) {
    const d = order.delivery
    let data
    try {
      data = await wxApi().queryOrder(d.courierOrderId ? { wx_order_id: d.courierOrderId } : { wx_store_id: settings.wechatStoreId, store_order_id: d.storeOrderId })
    } catch (e) {
      throw wxFail(e, '查配送进度')
    }
    return wechat.fromStatus(data)
  },

  // 微信的状态码（查单结果或者回调）换成我们的
  fromStatus(data) {
    const code = Number(data.order_status)
    const out = { status: WX_STATUS[code] || '', code, note: WX_NOTE[code] || '' }
    const rider = riderOf(data)
    if (rider) out.rider = rider
    if (data.service_trans_id) {
      out.carrier = String(data.service_trans_id)
      out.carrierName = carrierName(data.service_trans_id)
    }
    if (data.actualfee !== undefined) out.courierFee = Number(data.actualfee) || 0
    if (data.deductfee !== undefined) out.deductFee = Number(data.deductfee) || 0
    return out
  },

  // 取消：骑手接单后取消，配送公司会扣违约金（顺丰、达达一般 2 元），返回 { deductFee }
  async cancel({ settings, order }) {
    const d = order.delivery
    let data
    try {
      data = await wxApi().cancelOrder(Object.assign(
        d.courierOrderId ? { wx_order_id: d.courierOrderId } : { wx_store_id: settings.wechatStoreId, store_order_id: d.storeOrderId },
        { cancel_reason_id: 1, cancel_reason: '商家取消' }
      ))
    } catch (e) {
      throw wxFail(e, '取消配送')
    }
    return { deductFee: Number(data.deductfee) || 0 }
  },

  // 开通门店（第一次）或者更新门店信息：店名、地址、电话、派单方式。返回微信的门店编号 wx_store_id
  async setupStore(settings, outStoreId) {
    const st = settings.store
    const content = {
      store_name: st.name,
      order_pattern: settings.wechatPattern === 'prefer' ? 2 : 1,
      address_info: {
        province: st.province,
        city: st.city,
        area: st.area,
        street: st.street,
        house: st.house,
        phone: st.phone,
        lat: settings.location.lat,
        lng: settings.location.lng
      }
    }
    if (settings.wechatPattern === 'prefer') content.service_trans_prefer = settings.wechatPrefer
    const api = wxApi()
    try {
      await api.apply()
    } catch (e) {
      // 已经开通过门店权限的会报错，不影响下面
      console.warn('同城配送开通门店权限', e.errCode, e.errMsg || e.message)
    }
    let found = null
    try {
      const q = await api.queryStore({ out_store_id: outStoreId })
      found = (q.store_list || []).find((x) => x.wx_store_id) || null
    } catch (e) {
      // 还没有门店时查不到
    }
    try {
      if (found) {
        await api.updateStore({ keys: { wx_store_id: found.wx_store_id }, content })
        return String(found.wx_store_id)
      }
      const created = await api.createStore(Object.assign({ out_store_id: outStoreId }, content))
      if (!created.wx_store_id) throw new BizError('微信没返回门店编号，请稍后再试')
      return String(created.wx_store_id)
    } catch (e) {
      if (e instanceof BizError) throw e
      throw wxFail(e, found ? '更新门店' : '开通门店')
    }
  },

  // 门店在各家配送公司的运费余额：[{ carrier, carrierName, balance（分） }]
  async balance(settings) {
    let data
    try {
      data = await wxApi().balance({ wx_store_id: settings.wechatStoreId, pay_mode: 'PAY_MODE_STORE' })
    } catch (e) {
      throw wxFail(e, '查运费余额')
    }
    return (data.balance_list || []).map((b) => ({ carrier: b.service_trans_id, carrierName: carrierName(b.service_trans_id), balance: Number(b.balance) || 0 }))
  },

  // 充运费：返回微信的充值页面地址，用微信扫码打开付款；amount 分，50 元起
  async charge(settings, carrier, amount) {
    let data
    try {
      data = await wxApi().charge({ wx_store_id: settings.wechatStoreId, service_trans_id: carrier, amount, pay_mode: 'PAY_MODE_STORE' })
    } catch (e) {
      throw wxFail(e, '充运费')
    }
    if (!data.payurl) throw new BizError('微信没返回充值地址，请稍后再试')
    return String(data.payurl)
  },

  // 沙箱测试单没有真骑手：让微信假装骑手到了某一步
  async mock({ settings, order }, status) {
    const code = Number(Object.keys(WX_STATUS).find((k) => WX_STATUS[k] === status && k !== '60000'))
    if (!code) throw new BizError('不能模拟这个状态')
    try {
      await wxApi().mockNotify({ wx_store_id: settings.wechatStoreId, store_order_id: order.delivery.storeOrderId, order_status: code })
    } catch (e) {
      throw wxFail(e, '模拟骑手状态')
    }
  }
}

const self = {
  key: 'self',
  name: '店员自己送',
  external: false,
  ready: () => true,
  sandbox: () => false,
  async create({ order }) {
    return { status: 'delivering', attempts: (order.delivery.attempts || 0) + 1, courierOrderId: '', carrier: '', carrierName: '', courierFee: 0 }
  }
}

const ADAPTERS = { self, wechat }

function adapterOf(key) {
  const a = ADAPTERS[key]
  if (!a) throw new BizError('不认识的配送方式')
  return a
}

module.exports = { STATUS_TEXT, LIVE, WX_STATUS, WX_CARRIERS, carrierName, adapterOf, wechat }
