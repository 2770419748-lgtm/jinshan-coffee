const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    payEnabled: false,
    mchId: '',
    allowCounter: true,
    saving: false
  },

  onLoad() {
    guard.loadStaff(['owner']).then((staff) => {
      if (!staff) return
      api.common('getShopSettings').then((s) => {
        this.setData(Object.assign({ ready: true }, s))
      }).catch(api.toastError)
    })
  },

  onMchId(e) {
    this.setData({ mchId: e.detail.value.trim() })
  },

  onPay(e) {
    const on = e.detail.value
    // 关掉微信支付时只能到吧台付款
    this.setData(on ? { payEnabled: true } : { payEnabled: false, allowCounter: true })
  },

  onCounter(e) {
    this.setData({ allowCounter: e.detail.value })
  },

  save() {
    const { payEnabled, mchId, allowCounter, saving } = this.data
    if (saving) return
    if (mchId && !/^\d{8,12}$/.test(mchId)) {
      wx.showToast({ title: '商户号是 8 到 12 位数字', icon: 'none' })
      return
    }
    if (payEnabled && !mchId) {
      wx.showToast({ title: '打开微信支付前先填商户号', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.common('saveShopSettings', { payEnabled, mchId, allowCounter }).then((s) => {
      this.setData(Object.assign({ saving: false }, s))
      wx.showToast({ title: '已保存', icon: 'success' })
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  }
})
