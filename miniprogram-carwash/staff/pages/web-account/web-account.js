const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const config = require('../../../config')

Page({
  data: {
    ready: false,
    current: '', // 已经设好的账号
    webUrl: config.webAdminUrl || (api.base() ? api.base() + '/admin/' : ''),
    username: '',
    password: '',
    password2: '',
    saving: false
  },

  onLoad() {
    guard.loadStaff().then((staff) => {
      if (!staff) return
      api.common('getWebAccount').then(({ username }) => {
        this.setData({ ready: true, current: username, username })
      }).catch(api.toastError)
    })
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  save() {
    const { username, password, password2, saving } = this.data
    if (saving) return
    if (!/^[a-z0-9_]{3,20}$/.test(username.trim().toLowerCase())) {
      wx.showToast({ title: '账号用 3 到 20 位小写字母、数字或下划线', icon: 'none' })
      return
    }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      wx.showToast({ title: '密码至少 8 位，要有字母和数字', icon: 'none' })
      return
    }
    if (password !== password2) {
      wx.showToast({ title: '两次密码不一样', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.common('setWebAccount', { username, password }).then((res) => {
      this.setData({ saving: false, current: res.username, username: res.username, password: '', password2: '' })
      wx.showModal({ title: '设置好了', content: '在电脑上打开网页后台，用账号「' + res.username + '」和刚才的密码登录。', showCancel: false })
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  copyUrl() {
    wx.setClipboardData({ data: this.data.webUrl })
  },

  clear() {
    wx.showModal({
      title: '停用网页后台',
      content: '电脑上会马上退出登录。',
      confirmText: '停用',
      success: (res) => {
        if (!res.confirm) return
        api.common('clearWebAccount').then(() => {
          this.setData({ current: '', username: '' })
          wx.showToast({ title: '已停用', icon: 'success' })
        }).catch(api.toastError)
      }
    })
  }
})
