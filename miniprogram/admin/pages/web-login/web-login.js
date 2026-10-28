const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const loginScene = require('../../../utils/login-scene')

// 电脑网页后台扫码登录的确认页
Page({
  data: {
    state: 'loading', // loading / confirm / done / cancelled / expired / invalid
    staff: null,
    busy: false
  },

  onLoad(options) {
    this.id = loginScene.parseQuery(options)
    if (!this.id) {
      this.setData({ state: 'invalid' })
      return
    }
    guard.loadStaff().then((staff) => {
      if (!staff) return
      api.common('getWebLogin', { id: this.id }).then(({ status, staff }) => {
        this.setData({ staff, state: status === 'waiting' ? 'confirm' : 'expired' })
      }).catch((err) => {
        this.setData({ state: 'expired' })
        if (err.code !== 'TICKET_GONE') api.toastError(err)
      })
    })
  },

  confirm() {
    if (this.data.busy) return
    this.setData({ busy: true })
    api.common('confirmWebLogin', { id: this.id }).then(() => {
      this.setData({ busy: false, state: 'done' })
    }).catch((err) => {
      this.setData({ busy: false })
      if (err.code === 'TICKET_GONE') this.setData({ state: 'expired' })
      else api.toastError(err)
    })
  },

  cancel() {
    api.common('cancelWebLogin', { id: this.id }).catch(() => {})
    this.setData({ state: 'cancelled' })
  },

  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/mine/mine' }) })
  }
})
