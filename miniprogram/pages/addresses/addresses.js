const api = require('../../utils/api')

// 收货地址：外送用。结算页带 select=1 打开时，点一个地址就选它回去
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
    api.coffee('listAddresses').then((list) => this.setData({ list, loaded: true })).catch((err) => {
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
    wx.navigateTo({ url: '/pages/address-edit/address-edit?id=' + e.currentTarget.dataset.id + (this.data.select ? '&select=1' : '') })
  },

  add() {
    wx.navigateTo({ url: '/pages/address-edit/address-edit' + (this.data.select ? '?select=1' : '') })
  }
})
