const api = require('../../utils/api')
const session = require('../../utils/session')

Page({
  data: {
    type: 'staff',
    name: '',
    code: '',
    codeRequired: true,
    submitting: false
  },

  onLoad(options) {
    const type = options.type === 'owner' ? 'owner' : 'staff'
    wx.setNavigationBarTitle({ title: type === 'owner' ? '店主绑定' : '员工绑定' })
    this.setData({ type })
    if (type === 'owner') {
      session.getUser().then((user) => {
        this.setData({ codeRequired: !!user.ownerCodeRequired })
      }).catch(() => {})
    }
  },

  onName(e) {
    this.setData({ name: e.detail.value })
  },

  onCode(e) {
    this.setData({ code: e.detail.value })
  },

  submit() {
    const { type, name, code, codeRequired, submitting } = this.data
    if (submitting) return
    if (!name.trim()) {
      wx.showToast({ title: '请填写称呼', icon: 'none' })
      return
    }
    if ((type === 'staff' || codeRequired) && !code.trim()) {
      wx.showToast({ title: type === 'staff' ? '请填写邀请码' : '请填写绑定码', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.common(type === 'owner' ? 'bindOwner' : 'bindStaff', { name, code })
      .then((staff) => {
        session.clearUser()
        wx.showToast({ title: '已绑定为' + staff.roleName, icon: 'success' })
        setTimeout(() => wx.redirectTo({ url: '/admin/pages/home/home' }), 800)
      })
      .catch((err) => {
        this.setData({ submitting: false })
        api.toastError(err)
      })
  }
})
