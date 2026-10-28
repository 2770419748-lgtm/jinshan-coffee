const api = require('../../utils/api')
const starUtil = require('../../utils/stars')

Page({
  data: {
    loading: true,
    info: null, // { enabled, need, stars, pending, expiring, memberNo, ... }
    dots: [],
    percent: 0,
    tip: '',
    rules: [],
    logs: [],
    hasMore: false
  },

  onShow() {
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
    return api.coffee('myStars', { page: this.page }).then((res) => {
      this.page++
      const data = { logs: reset ? res.logs : this.data.logs.concat(res.logs), hasMore: res.hasMore, loading: false }
      if (reset) {
        Object.assign(data, {
          info: res,
          dots: starUtil.dots(res.stars, res.need),
          percent: Math.min(100, Math.round(res.stars / res.need * 100)),
          tip: starUtil.tip(res.stars, res.need),
          rules: starUtil.ruleLines(res)
        })
      }
      this.setData(data)
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  goMenu() {
    wx.switchTab({ url: '/pages/menu/menu' })
  }
})
