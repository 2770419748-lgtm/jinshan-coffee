const api = require('../../utils/api')

Page({
  data: {
    logs: [],
    hasMore: false,
    loaded: false
  },

  onLoad() {
    this.page = 0
    this.more()
  },

  onReachBottom() {
    if (this.data.hasMore) this.more()
  },

  more() {
    api.carwash('myMemberLogs', { page: this.page }).then((res) => {
      this.page++
      this.setData({ logs: this.data.logs.concat(res.logs), hasMore: res.hasMore, loaded: true })
    }).catch((err) => {
      this.setData({ loaded: true })
      api.toastError(err)
    })
  }
})
