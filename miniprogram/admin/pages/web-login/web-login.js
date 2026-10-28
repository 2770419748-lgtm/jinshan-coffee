const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const loginScene = require('../../../utils/login-scene')
const server = require('../../../utils/server')
const session = require('../../../utils/session')
const cart = require('../../../utils/cart')

// 电脑网页后台扫码登录的确认页
Page({
  data: {
    state: 'loading', // loading / confirm / done / cancelled / expired / invalid / switch（码是另一台服务器的）
    target: '', // 码是哪台服务器的：test / prod
    staff: null,
    busy: false
  },

  onLoad(options) {
    this.id = loginScene.parseQuery(options)
    if (!this.id) {
      this.setData({ state: 'invalid' })
      return
    }
    // 开发版、体验版能切服务器：扫的是另一台服务器后台的码，先切过去才认得这个码
    const target = loginScene.parseServer(options)
    if (server.canSwitch() && server.current() !== target) {
      this.setData({ state: 'switch', target })
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

  switchServer() {
    const target = this.data.target
    server.set(target)
    cart.clear()
    session.clearUser()
    wx.redirectTo({ url: '/admin/pages/web-login/web-login?id=' + this.id + (target === 'test' ? '&s=t' : '') })
  },

  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/mine/mine' }) })
  }
})
