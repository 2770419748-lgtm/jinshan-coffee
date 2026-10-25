const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const { fenToText, textToFen } = require('../../../utils/money')

function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

Page({
  data: {
    ready: false,
    isOwner: false,
    member: null,
    logs: [],
    plans: [],
    showRecharge: false,
    showAdjust: false,
    adjust: { sign: -1, amountText: '', untilMode: 'keep', until: '', reason: '' },
    busy: false
  },

  onLoad(options) {
    this.no = options.no
    guard.loadStaff(guard.COFFEE_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true, isOwner: staff.role === 'owner' })
      this.load()
    })
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.member('getMemberDetail', { memberNo: this.no }).then(({ member, logs, plans }) => {
      this.setData({ member, logs, plans })
    }).catch(api.toastError)
  },

  editRemark() {
    wx.showModal({
      title: '备注',
      editable: true,
      placeholderText: '名字、手机尾号，方便找',
      content: this.data.member.remark,
      success: (res) => {
        if (!res.confirm) return
        api.member('setMemberRemark', { memberNo: this.no, remark: res.content || '' })
          .then(() => this.load())
          .catch(api.toastError)
      }
    })
  },

  // ---------- 吧台充值 ----------

  openRecharge() {
    if (!this.data.plans.length) {
      wx.showModal({ title: '没有能充的档位', content: '店主还没在「储值设置」里加充值档位，或者储值还没开。', showCancel: false })
      return
    }
    this.setData({ showRecharge: true })
  },

  closeSheets() {
    this.setData({ showRecharge: false, showAdjust: false })
  },

  recharge(e) {
    const plan = this.data.plans[Number(e.currentTarget.dataset.index)]
    if (!plan || this.data.busy) return
    const gift = plan.memberDays ? '，送 ' + plan.memberDays + ' 天会员' : ''
    wx.showModal({
      title: '确认收到钱了吗',
      content: '已经收到顾客 ¥' + fenToText(plan.price) + '（现金或收款码）。给会员 ' + this.no + ' 充 ¥' + fenToText(plan.price + plan.bonus) + gift + '。',
      confirmText: '确认充值',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ busy: true })
        api.member('counterRecharge', { memberNo: this.no, planId: plan._id }).then((r) => {
          this.setData({ busy: false, showRecharge: false })
          wx.showToast({ title: '已充值，余额 ¥' + fenToText(r.balance), icon: 'none', duration: 2500 })
          this.load()
        }).catch((err) => {
          this.setData({ busy: false })
          api.toastError(err)
        })
      }
    })
  },

  // ---------- 店主调整 ----------

  openAdjust() {
    const m = this.data.member
    this.setData({
      showAdjust: true,
      adjust: { sign: -1, amountText: '', untilMode: 'keep', until: m.memberUntil || today(), reason: '' }
    })
  },

  onAdjust(e) {
    this.setData({ ['adjust.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  pickSign(e) {
    this.setData({ 'adjust.sign': Number(e.currentTarget.dataset.sign) })
  },

  pickUntilMode(e) {
    this.setData({ 'adjust.untilMode': e.currentTarget.dataset.mode })
  },

  submitAdjust() {
    const { adjust, busy, member } = this.data
    if (busy) return
    const fen = textToFen(adjust.amountText)
    if (fen === null) {
      wx.showToast({ title: '金额填错了', icon: 'none' })
      return
    }
    const params = { memberNo: this.no, amount: adjust.sign * fen, reason: adjust.reason.trim() }
    if (adjust.untilMode === 'set') params.memberUntil = adjust.until
    if (adjust.untilMode === 'clear') params.memberUntil = ''
    if (!fen && params.memberUntil === undefined) {
      wx.showToast({ title: '金额和会员到期日都没改', icon: 'none' })
      return
    }
    if (!params.reason) {
      wx.showToast({ title: '请写上原因，比如「线下退款」', icon: 'none' })
      return
    }
    if (params.amount < 0 && -params.amount > member.balance) {
      wx.showToast({ title: '余额只有 ¥' + fenToText(member.balance), icon: 'none' })
      return
    }
    this.setData({ busy: true })
    api.member('adjustMember', params).then(() => {
      this.setData({ busy: false, showAdjust: false })
      wx.showToast({ title: '已调整', icon: 'success' })
      this.load()
    }).catch((err) => {
      this.setData({ busy: false })
      api.toastError(err)
    })
  }
})
