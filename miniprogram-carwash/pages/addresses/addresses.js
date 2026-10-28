const api = require('../../utils/api')

Page({
  data: {
    select: false,
    list: [],
    loaded: false
  },

  onLoad(options) {
    this.setData({ select: options.select === '1' })
  },

  onShow() {
    api.carwash('listAddresses').then((list) => this.setData({ list, loaded: true })).catch((err) => {
      this.setData({ loaded: true })
      api.toastError(err)
    })
  },

  pick(e) {
    const a = this.data.list[e.currentTarget.dataset.index]
    if (!this.data.select) {
      wx.navigateTo({ url: '/pages/address-edit/address-edit?id=' + a._id })
      return
    }
    getApp().globalData.pickedAddress = a
    wx.navigateBack()
  },

  edit(e) {
    wx.navigateTo({ url: '/pages/address-edit/address-edit?id=' + e.currentTarget.dataset.id })
  },

  add() {
    wx.navigateTo({ url: '/pages/address-edit/address-edit' })
  }
})
