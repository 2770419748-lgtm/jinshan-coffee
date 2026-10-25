const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const nonce = require('../../../utils/nonce')

const yuan = (fen) => String((fen || 0) / 100)

Page({
  data: {
    staff: null,
    no: '',
    m: null
  },

  onLoad() {
    // 每张卡一个请求号，扣成功才换：网络断了重试也只扣一次
    this.nonces = {}
    guard.loadStaff().then((staff) => {
      if (staff) this.setData({ staff })
    })
  },

  onNo(e) {
    this.setData({ no: e.detail.value })
  },

  find() {
    const no = this.data.no.trim()
    if (!no) return wx.showToast({ title: '请输入会员号', icon: 'none' })
    return api.carwash('staffFindMember', { memberNo: no }).then((m) => this.setData({ m })).catch((err) => {
      this.setData({ m: null })
      api.toastError(err)
    })
  },

  refresh() {
    return api.carwash('staffFindMember', { memberNo: this.data.m.member.memberNo }).then((m) => this.setData({ m })).catch(api.toastError)
  },

  confirmThen(title, content, fn) {
    wx.showModal({
      title,
      content,
      confirmText: '确认',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '请稍等', mask: true })
        fn().then((msg) => {
          wx.hideLoading()
          wx.showModal({ title: '好了', content: msg, showCancel: false })
          this.refresh()
        }).catch((err) => {
          wx.hideLoading()
          api.toastError(err)
          this.refresh()
        })
      }
    })
  },

  recharge(e) {
    const { m } = this.data
    const p = m.plans[e.currentTarget.dataset.index]
    const gift = p.memberDays ? '，送 ' + p.memberDays + ' 天会员' : ''
    this.confirmThen('确认收到钱了吗', '已经收到顾客 ¥' + yuan(p.price) + '。给会员 ' + m.member.memberNo + ' 充 ¥' + yuan(p.price + p.bonus) + gift + '。', () =>
      api.carwash('counterRecharge', { memberNo: m.member.memberNo, planId: p._id }).then((res) =>
        '余额 ¥' + yuan(res.balance) + (res.vouchers ? '，送了 ' + res.vouchers + ' 张咖啡券' : '')))
  },

  sellCard(e) {
    const { m } = this.data
    const t = m.cardTypes[e.currentTarget.dataset.index]
    this.confirmThen('确认收到钱了吗', '已经收到顾客 ¥' + yuan(t.price) + '。给会员 ' + m.member.memberNo + ' 开一张「' + t.name + '」（' + t.times + ' 次）。', () =>
      api.carwash('counterSellCard', { memberNo: m.member.memberNo, typeId: t._id }).then((res) => '已开卡「' + res.card.name + '」，' + res.card.remaining + ' 次'))
  },

  useCard(e) {
    const { m } = this.data
    const c = m.cards[e.currentTarget.dataset.index]
    if (!this.nonces[c._id]) this.nonces[c._id] = nonce()
    const id = this.nonces[c._id]
    this.confirmThen('扣一次次卡', '「' + c.name + '」现在剩 ' + c.remaining + ' 次，扣 1 次。', () =>
      api.carwash('staffUseCard', { memberNo: m.member.memberNo, cardId: c._id, nonce: id }).then((res) => {
        delete this.nonces[c._id]
        return (res.duplicate ? '刚才已经扣过了，' : '已扣 1 次，') + '还剩 ' + res.remaining + ' 次'
      }))
  }
})
