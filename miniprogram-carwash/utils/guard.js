// 员工页面的权限检查：不是洗车的员工就退回去
const api = require('./api')
const session = require('./session')

const ADMIN_ROLES = ['owner', 'carwash_manager']
const STAFF_ROLES = ['owner', 'carwash_manager', 'technician']

function leave() {
  wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/mine/mine' }) })
}

// 返回员工信息（多一个 isAdmin：店主、洗车店长）；没有权限时弹窗并返回 null
function loadStaff() {
  return session.getUser(true).then((user) => {
    const staff = user && user.staff
    if (!staff || STAFF_ROLES.indexOf(staff.role) === -1) {
      wx.showModal({
        title: '没有权限',
        content: staff ? '这里是洗车店员工用的，你的角色用不了。' : '只有洗车店的员工能进。',
        showCancel: false,
        complete: leave
      })
      return null
    }
    return Object.assign({ isAdmin: ADMIN_ROLES.indexOf(staff.role) !== -1 }, staff)
  }).catch((err) => {
    api.toastError(err)
    return null
  })
}

function isStaff(staff) {
  return !!staff && STAFF_ROLES.indexOf(staff.role) !== -1
}

module.exports = { ADMIN_ROLES, STAFF_ROLES, loadStaff, isStaff }
