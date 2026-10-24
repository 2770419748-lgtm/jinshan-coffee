const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    loading: true,
    list: [],
    trial: false // 生成体验版桌码（小程序发布前测试用）
  },

  onShow() {
    guard.loadStaff(guard.COFFEE_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true })
      this.load()
    })
  },

  load() {
    return api.coffee('listTables').then((list) => {
      this.setData({ list, loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  onTrial(e) {
    this.setData({ trial: e.detail.value })
  },

  add() {
    wx.showModal({
      title: '添加桌号',
      editable: true,
      placeholderText: '比如 1、2、A3，最多 8 位',
      success: (res) => {
        const tableNo = String(res.content || '').trim()
        if (!res.confirm || !tableNo) return
        api.coffee('saveTable', { tableNo }).then(() => this.load()).catch(api.toastError)
      }
    })
  },

  gen(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    wx.showLoading({ title: '生成中', mask: true })
    api.coffee('genTableCode', { id: item._id, envVersion: this.data.trial ? 'trial' : 'release' }).then(() => {
      wx.hideLoading()
      this.load()
    }).catch((err) => {
      wx.hideLoading()
      wx.showModal({ title: '没能生成', content: api.errorText(err), showCancel: false })
    })
  },

  preview(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    if (item.qrcode) wx.previewImage({ urls: [item.qrcode] })
  },

  save(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    wx.showLoading({ title: '保存中', mask: true })
    wx.cloud.downloadFile({ fileID: item.qrcode }).then((res) => {
      wx.saveImageToPhotosAlbum({
        filePath: res.tempFilePath,
        success: () => {
          wx.hideLoading()
          wx.showToast({ title: '已存到相册', icon: 'success' })
        },
        fail: (err) => {
          wx.hideLoading()
          if (/auth|deny/i.test(err.errMsg || '')) {
            wx.showModal({ title: '需要相册权限', content: '请在设置里允许保存到相册。', confirmText: '去设置', success: (r) => { if (r.confirm) wx.openSetting() } })
          }
        }
      })
    }).catch((err) => {
      wx.hideLoading()
      api.toastError(err)
    })
  },

  remove(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    wx.showModal({
      title: '删除桌号',
      content: '删除后，桌上贴的 ' + item.tableNo + ' 号桌码就不能再下单了。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('deleteTable', { id: item._id }).then(() => this.load()).catch(api.toastError)
      }
    })
  }
})
