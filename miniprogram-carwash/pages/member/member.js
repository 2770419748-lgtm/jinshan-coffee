const api = require('../../utils/api')
const pay = require('../../utils/pay')

Page({
  data: {
    member: null,
    settings: {},
    plans: [],
    cardTypes: [],
    cards: [],
    pay: { wechat: false },
    error: ''
  },

  onShow() {
    this.load()
  },

  load() {
    return api.carwash('getMember').then((res) => {
      this.setData({ member: res.member, settings: res.settings, plans: res.plans, cardTypes: res.cardTypes, cards: res.cards, pay: res.pay, error: '' })
    }).catch((err) => this.setData({ error: api.errorText(err) }))
  },

  atCounter(what) {
    wx.showModal({
      title: '到店' + what,
      content: '店里还没开通在线付款。到店里付钱，报会员号 ' + this.data.member.memberNo + '，店员给你' + what + '。',
      showCancel: false
    })
  },

  recharge(e) {
    if (!this.data.pay.wechat) return this.atCounter('充值')
    pay.payRecharge(e.currentTarget.dataset.id).then((paid) => {
      if (paid) wx.showToast({ title: '充值成功', icon: 'success' })
      this.load()
    })
  },

  // 办卡：能微信付、能余额付的让顾客选
  buyCard(e) {
    const type = this.data.cardTypes[e.currentTarget.dataset.index]
    const { member, settings } = this.data
    const ways = []
    if (this.data.pay.wechat) ways.push('wechat')
    if (settings.enabled && member.balance >= type.price) ways.push('balance')
    if (!ways.length) return this.atCounter('办卡')
    const done = (ok) => {
      if (ok) wx.showToast({ title: '办好了', icon: 'success' })
      this.load()
    }
    if (ways.length === 1) {
      ;(ways[0] === 'wechat' ? pay.payCard(type._id) : pay.cardByBalance(type._id, type.price)).then(done)
      return
    }
    wx.showActionSheet({
      itemList: ['微信支付 ¥' + type.price / 100, '洗车余额付（余额 ¥' + member.balance / 100 + '）'],
      success: (res) => {
        ;(res.tapIndex === 0 ? pay.payCard(type._id) : pay.cardByBalance(type._id, type.price)).then(done)
      }
    })
  },

  goLogs() {
    wx.navigateTo({ url: '/pages/member-logs/member-logs' })
  },

  goCards() {
    wx.navigateTo({ url: '/pages/cards/cards' })
  }
})
