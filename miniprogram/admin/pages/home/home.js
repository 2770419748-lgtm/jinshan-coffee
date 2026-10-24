const guard = require('../../../utils/guard')
const loginScene = require('../../../utils/login-scene')

Page({
  data: {
    staff: null,
    isOwner: false,
    canCoffee: false,
    canBook: false
  },

  onShow() {
    guard.loadStaff().then((staff) => {
      if (!staff) return
      this.setData({
        staff,
        isOwner: staff.role === 'owner',
        canCoffee: guard.COFFEE_ROLES.indexOf(staff.role) !== -1,
        canBook: guard.BOOK_ROLES.indexOf(staff.role) !== -1
      })
    })
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },

  // 也可以直接用微信扫一扫，效果一样
  scanLogin() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['wxCode', 'qrCode'],
      success: (res) => {
        const id = loginScene.parsePath(res.path)
        if (!id) {
          wx.showToast({ title: '这不是网页后台的登录码', icon: 'none' })
          return
        }
        wx.navigateTo({ url: '/admin/pages/web-login/web-login?id=' + id })
      }
    })
  }
})
