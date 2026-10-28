const api = require('../../utils/api')
const session = require('../../utils/session')

Page({
  data: {
    name: '',
    code: '',
    submitting: false
  },

  onName(e) {
    this.setData({ name: e.detail.value })
  },

  onCode(e) {
    this.setData({ code: e.detail.value })
  },

  submit() {
    const { name, code, submitting } = this.data
    if (submitting) return
    if (!name.trim()) return wx.showToast({ title: '请填写称呼', icon: 'none' })
    if (!code.trim()) return wx.showToast({ title: '请填写邀请码', icon: 'none' })
    this.setData({ submitting: true })
    api.common('bindStaff', { name, code }).then((staff) => {
      session.clearUser()
      wx.showToast({ title: '已绑定为' + staff.roleName, icon: 'success' })
      setTimeout(() => wx.redirectTo({ url: '/staff/pages/orders/orders' }), 800)
    }).catch((err) => {
      this.setData({ submitting: false })
      api.toastError(err)
    })
  }
})
