const api = require('../../utils/api')

Page({
  data: {
    book: null,
    rules: [],
    ruleIndex: 0,
    hours: 1,
    fee: 0,
    remark: '',
    loading: true,
    submitting: false
  },

  onLoad(options) {
    this.id = options.id
    this.load()
  },

  load() {
    return api.book('getBook', { id: this.id }).then(({ book, rules }) => {
      wx.setNavigationBarTitle({ title: book.title })
      const keep = this.data.rules[this.data.ruleIndex]
      const index = keep ? rules.findIndex((r) => r._id === keep._id) : -1
      this.setData({ book, rules, loading: false })
      this.pickRuleAt(index === -1 ? 0 : index)
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  pickRuleAt(index) {
    const rule = this.data.rules[index]
    if (!rule) {
      this.setData({ ruleIndex: 0, fee: 0 })
      return
    }
    const hours = rule.type === 'hourly'
      ? Math.min(rule.maxHours, Math.max(rule.minHours, this.data.hours))
      : 0
    this.setData({ ruleIndex: index, hours: hours || this.data.hours, fee: rule.type === 'hourly' ? rule.price * hours : rule.price })
  },

  pickRule(e) {
    this.pickRuleAt(Number(e.currentTarget.dataset.index))
  },

  changeHours(e) {
    const rule = this.data.rules[this.data.ruleIndex]
    const hours = Math.min(rule.maxHours, Math.max(rule.minHours, this.data.hours + Number(e.currentTarget.dataset.delta)))
    this.setData({ hours, fee: rule.price * hours })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    const { book, rules, ruleIndex, hours, remark, submitting } = this.data
    const rule = rules[ruleIndex]
    if (submitting || !book || !rule || !book.available) return
    this.setData({ submitting: true })
    api.book('createRental', { bookId: book._id, ruleId: rule._id, hours, remark }).then(({ id }) => {
      wx.redirectTo({ url: '/pages/rental-detail/rental-detail?id=' + id })
    }).catch((err) => {
      this.setData({ submitting: false })
      if (err.code === 'SHELF_CHANGED') {
        wx.showModal({ title: '没能借书', content: err.message, showCancel: false })
        this.load()
        return
      }
      api.toastError(err)
    })
  }
})
