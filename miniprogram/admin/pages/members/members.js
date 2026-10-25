const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    isOwner: false,
    keyword: '',
    members: [],
    hasMore: false,
    loading: true,
    stats: null // 店主看：今天充值、余额消费、大家手里一共还有多少余额
  },

  onShow() {
    guard.loadStaff(guard.COFFEE_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true, isOwner: staff.role === 'owner' })
      this.load(true)
      if (staff.role === 'owner') this.loadStats()
    })
  },

  onPullDownRefresh() {
    Promise.all([this.load(true), this.data.isOwner ? this.loadStats() : null]).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false)
  },

  load(reset) {
    if (reset) this.page = 0
    this.setData({ loading: true })
    return api.member('listMembers', { keyword: this.data.keyword, page: this.page }).then(({ members, hasMore }) => {
      this.page++
      this.setData({ members: reset ? members : this.data.members.concat(members), hasMore, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  loadStats() {
    return api.member('memberSummary', {}).then((s) => {
      this.setData({ stats: { recharge: s.totals.onlineFee + s.totals.counterFee, spent: s.totals.spentFee, balanceTotal: s.balanceTotal, memberCount: s.memberCount } })
    }).catch(() => {})
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.load(true)
  },

  clear() {
    this.setData({ keyword: '' })
    this.load(true)
  },

  open(e) {
    wx.navigateTo({ url: '/admin/pages/member-detail/member-detail?no=' + e.currentTarget.dataset.no })
  },

  goSettings() {
    wx.navigateTo({ url: '/admin/pages/member-settings/member-settings' })
  }
})
