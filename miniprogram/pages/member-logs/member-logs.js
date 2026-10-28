const api = require('../../utils/api')

Page({
  data: {
    logs: [],
    hasMore: false,
    loading: true
  },

  onLoad() {
    this.page = 0
    this.load(true)
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false)
  },

  load(reset) {
    if (reset) this.page = 0
    this.setData({ loading: true })
    return api.member('myMemberLogs', { page: this.page }).then(({ logs, hasMore }) => {
      this.page++
      this.setData({ logs: reset ? logs : this.data.logs.concat(logs), hasMore, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  }
})
