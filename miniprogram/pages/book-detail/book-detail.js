const api = require('../../utils/api')
const pay = require('../../utils/pay')
const { fenToText } = require('../../utils/money')

// 借书能怎么付：微信支付、会员余额、到吧台付
function payMethods(payInfo, member) {
  const list = []
  if (payInfo.enabled) list.push({ key: 'wechat', label: '微信支付' })
  if (member.enabled || member.balance > 0) list.push({ key: 'balance', label: '余额 ¥' + fenToText(member.balance) })
  if (payInfo.allowCounter) list.push({ key: 'counter', label: payInfo.enabled ? '到吧台付' : '到吧台付款' })
  return list
}

Page({
  data: {
    book: null,
    rules: [],
    ruleIndex: 0,
    useMember: false, // 选了「会员畅读」：免费、当天还
    member: null, // { enabled, free, canFree, isMember, memberUntil, balance }
    hours: 1,
    fee: 0,
    remark: '',
    payInfo: null, // { enabled, allowCounter }
    methods: [],
    payMethod: 'counter',
    loading: true,
    submitting: false
  },

  onLoad(options) {
    this.id = options.id
  },

  // 从会员中心充完值回来要刷新余额和会员状态
  onShow() {
    if (this.id) this.load()
  },

  load() {
    return api.book('getBook', { id: this.id }).then(({ book, rules, pay: payInfo, member }) => {
      wx.setNavigationBarTitle({ title: book.title })
      const keep = this.data.rules[this.data.ruleIndex]
      const index = keep ? rules.findIndex((r) => r._id === keep._id) : -1
      const methods = payMethods(payInfo, member)
      const data = { book, rules, payInfo, member, methods, loading: false }
      if (!this.methodPicked || !methods.some((m) => m.key === this.data.payMethod)) {
        data.payMethod = methods[0] ? methods[0].key : 'counter'
      }
      // 会员能免费看的书，默认选会员畅读
      if (!this.rulePicked) data.useMember = member.canFree
      else if (!member.canFree) data.useMember = false
      this.setData(data)
      this.pickRuleAt(index === -1 ? 0 : index)
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  pickRuleAt(index) {
    const rule = this.data.rules[index]
    if (!rule || this.data.useMember) {
      this.setData({ ruleIndex: rule ? index : 0, fee: 0 })
      return
    }
    const hours = rule.type === 'hourly'
      ? Math.min(rule.maxHours, Math.max(rule.minHours, this.data.hours))
      : 0
    this.setData({ ruleIndex: index, hours: hours || this.data.hours, fee: rule.type === 'hourly' ? rule.price * hours : rule.price })
  },

  pickRule(e) {
    this.rulePicked = true
    this.setData({ useMember: false })
    this.pickRuleAt(Number(e.currentTarget.dataset.index))
  },

  pickMember() {
    const { member } = this.data
    if (!member.canFree) {
      wx.navigateTo({ url: '/pages/member/member' })
      return
    }
    this.rulePicked = true
    this.setData({ useMember: true, fee: 0 })
  },

  changeHours(e) {
    const rule = this.data.rules[this.data.ruleIndex]
    const hours = Math.min(rule.maxHours, Math.max(rule.minHours, this.data.hours + Number(e.currentTarget.dataset.delta)))
    this.setData({ hours, fee: rule.price * hours })
  },

  pickPay(e) {
    this.methodPicked = true
    this.setData({ payMethod: e.currentTarget.dataset.method })
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    const { book, rules, ruleIndex, useMember, member, hours, remark, submitting, payMethod, fee } = this.data
    const rule = rules[ruleIndex]
    if (submitting || !book || (!rule && !useMember) || !book.available) return
    const byBalance = !useMember && payMethod === 'balance' && fee > 0
    if (byBalance && member.balance < fee) {
      wx.showModal({ title: '余额不够', content: '余额 ¥' + fenToText(member.balance) + '，要付 ¥' + fenToText(fee) + '。先去充值，或者换个付款方式。', showCancel: false })
      return
    }
    const params = { bookId: book._id, ruleId: useMember ? 'member' : rule._id, hours, remark }
    if (byBalance) params.payBy = 'balance'
    this.setData({ submitting: true })
    api.book('createRental', params).then(({ id }) => {
      const go = () => wx.redirectTo({ url: '/pages/rental-detail/rental-detail?id=' + id })
      if (!useMember && payMethod === 'wechat' && fee > 0) return pay.payRental(id).then(go)
      go()
    }).catch((err) => {
      this.setData({ submitting: false })
      if (err.code === 'SHELF_CHANGED' || err.code === 'BALANCE_LOW') {
        wx.showModal({ title: '没能借书', content: err.message, showCancel: false })
        this.load()
        return
      }
      api.toastError(err)
    })
  }
})
