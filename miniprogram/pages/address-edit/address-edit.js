const api = require('../../utils/api')

const PHONE_RE = /^(1\d{10}|0\d{2,3}-?\d{7,8})$/

Page({
  data: {
    form: { _id: '', place: '', detail: '', name: '', phone: '', location: null, isDefault: false },
    saving: false
  },

  onLoad(options) {
    // 从结算页选地址时打开的：保存后直接选这个地址回结算页
    this.select = options.select === '1'
    if (!options.id) return
    api.coffee('listAddresses').then((list) => {
      const a = list.find((x) => x._id === options.id)
      if (a) this.setData({ form: Object.assign({}, a) })
    }).catch(api.toastError)
  },

  // 腾讯地图选点，坐标和店里设置的位置是同一套，算距离准
  chooseLocation() {
    const f = this.data.form
    const opts = f.location ? { latitude: f.location.lat, longitude: f.location.lng } : {}
    wx.chooseLocation(Object.assign(opts, {
      success: (res) => {
        this.setData({
          'form.place': res.name || res.address,
          'form.location': { lat: res.latitude, lng: res.longitude }
        })
      },
      fail: (err) => {
        if (/cancel/i.test(err.errMsg || '')) return
        wx.showModal({ title: '打不开地图', content: '请在微信「设置 → 隐私」里允许使用位置，或者稍后再试。', showCancel: false })
      }
    }))
  },

  onDetail(e) {
    this.setData({ 'form.detail': e.detail.value })
  },

  onName(e) {
    this.setData({ 'form.name': e.detail.value })
  },

  onPhone(e) {
    this.setData({ 'form.phone': e.detail.value })
  },

  onDefault(e) {
    this.setData({ 'form.isDefault': e.detail.value })
  },

  save() {
    const f = this.data.form
    if (this.data.saving) return
    if (!f.location) return wx.showToast({ title: '请在地图上选位置', icon: 'none' })
    if (!f.name.trim()) return wx.showToast({ title: '请填联系人', icon: 'none' })
    if (!PHONE_RE.test(f.phone.trim())) return wx.showToast({ title: '电话格式不对', icon: 'none' })
    this.setData({ saving: true })
    api.coffee('saveAddress', { address: f }).then(({ id }) => {
      wx.showToast({ title: '已保存', icon: 'success' })
      if (this.select) {
        getApp().globalData.pickedAddress = Object.assign({}, f, { _id: id })
        // 跳过地址列表，直接回结算页
        const pages = getCurrentPages()
        const prev = pages[pages.length - 2]
        setTimeout(() => wx.navigateBack({ delta: prev && prev.route === 'pages/addresses/addresses' ? 2 : 1 }), 600)
        return
      }
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除地址',
      content: '确定删除这个地址吗？',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('deleteAddress', { id: this.data.form._id }).then(() => wx.navigateBack()).catch(api.toastError)
      }
    })
  }
})
