const guard = require('../../../utils/guard')

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
  }
})
