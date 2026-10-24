const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

const ROLE_KEYS = ['barista', 'book_manager', 'owner']
const ROLE_NAMES = ['咖啡师（只管咖啡后台）', '书籍管理员（只管书籍后台）', '店主（全部权限）']

Page({
  data: {
    ready: false,
    loading: true,
    list: [],
    invite: null
  },

  onShow() {
    guard.loadStaff(['owner']).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      this.load()
    })
  },

  load() {
    return api.common('listStaff').then((list) => {
      this.setData({ list, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  pickRole() {
    return new Promise((resolve) => {
      wx.showActionSheet({
        itemList: ROLE_NAMES,
        success: (res) => resolve(ROLE_KEYS[res.tapIndex]),
        fail: () => resolve(null)
      })
    })
  },

  invite() {
    this.pickRole().then((role) => {
      if (!role) return
      api.common('createInvite', { role }).then((invite) => {
        this.setData({ invite })
      }).catch(api.toastError)
    })
  },

  copyCode() {
    wx.setClipboardData({ data: this.data.invite.code })
  },

  closeInvite() {
    this.setData({ invite: null })
  },

  changeRole(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    this.pickRole().then((role) => {
      if (!role || role === item.role) return
      api.common('updateStaff', { id: item.id, role }).then(() => this.load()).catch(api.toastError)
    })
  },

  remove(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    wx.showModal({
      title: '移除员工',
      content: '移除后「' + item.name + '」就进不了后台了。',
      confirmText: '移除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.common('removeStaff', { id: item.id }).then(() => this.load()).catch(api.toastError)
      }
    })
  }
})
