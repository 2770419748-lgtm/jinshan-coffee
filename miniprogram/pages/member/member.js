const api = require('../../utils/api')
const pay = require('../../utils/pay')
const { fenToText } = require('../../utils/money')

Page({
  data: {
    loading: true,
    member: null, // { memberNo, balance, memberUntil, isMember }
    settings: null, // { enabled, freeCategories, notice }
    plans: [],
    planIndex: 0,
    payInfo: null,
    freeText: '',
    paying: false
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 第一次打开时服务器会发会员号
  load() {
    return api.member('getMember').then(({ member, settings, plans, pay: payInfo }) => {
      const keep = this.data.plans[this.data.planIndex]
      const index = keep ? plans.findIndex((p) => p._id === keep._id) : -1
      this.setData({
        member,
        settings,
        plans,
        payInfo,
        planIndex: index === -1 ? 0 : index,
        freeText: settings.freeCategories.join('、'),
        loading: false
      })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  pickPlan(e) {
    this.setData({ planIndex: Number(e.currentTarget.dataset.index) })
  },

  // 开通微信支付前到吧台充：顾客付钱给店员，报会员号
  recharge() {
    const { plans, planIndex, payInfo, member, paying } = this.data
    const plan = plans[planIndex]
    if (!plan || paying) return
    if (!payInfo.enabled) {
      wx.showModal({
        title: '到吧台充值',
        content: '付 ¥' + fenToText(plan.price) + ' 给店员，报会员号 ' + member.memberNo + '，店员当场给你充上。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    this.setData({ paying: true })
    pay.payRecharge(plan._id).then((paid) => {
      this.setData({ paying: false })
      if (paid) wx.showToast({ title: '充值成功', icon: 'success' })
      this.load()
    })
  },

  copyNo() {
    wx.setClipboardData({ data: this.data.member.memberNo })
  },

  goLogs() {
    wx.navigateTo({ url: '/pages/member-logs/member-logs' })
  },

  goBooks() {
    wx.switchTab({ url: '/pages/books/books' })
  }
})
