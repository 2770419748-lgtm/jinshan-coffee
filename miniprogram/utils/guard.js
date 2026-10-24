// 后台页面的权限检查：不是对应角色的员工就退回去
const api = require('./api')
const session = require('./session')

const COFFEE_ROLES = ['owner', 'barista']
const BOOK_ROLES = ['owner', 'book_manager']

function leave() {
  wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/mine/mine' }) })
}

// 返回员工信息；没有权限时弹窗并返回 null
function loadStaff(roles) {
  return session.getUser(true).then((user) => {
    const staff = user && user.staff
    if (!staff || (roles && roles.indexOf(staff.role) === -1)) {
      wx.showModal({
        title: '没有权限',
        content: staff ? '这个页面你的角色用不了，需要的话请找店主调整。' : '只有店主和员工能进后台。',
        showCancel: false,
        complete: leave
      })
      return null
    }
    return staff
  }).catch((err) => {
    api.toastError(err)
    return null
  })
}

module.exports = { COFFEE_ROLES, BOOK_ROLES, loadStaff }
