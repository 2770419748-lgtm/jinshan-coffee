const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    payReady: false, // 服务器配置文件里有没有填好微信支付
    mchId: '',
    payEnabled: false,
    allowCounter: true,
    hours: { open: '08:00', close: '22:00' },
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

  onPay(e) {
    const on = e.detail.value
    if (on && !this.data.payReady) {
      wx.showModal({ title: '还不能打开', content: '服务器上还没配置微信支付（商户号、API 证书和 APIv3 密钥），配置方法见下面的说明。', showCancel: false })
      this.setData({ payEnabled: false })
      return
    }
    // 关掉微信支付时只能到吧台付款
    this.setData(on ? { payEnabled: true } : { payEnabled: false, allowCounter: true })
  },

  onCounter(e) {
    this.setData({ allowCounter: e.detail.value })
  },

  onHours(e) {
    this.setData({ ['hours.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  save() {
    const { payEnabled, allowCounter, hours, saving } = this.data
    if (saving) return
    if (hours.close <= hours.open) {
      wx.showToast({ title: '打烊时间要晚于开门时间', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.common('saveShopSettings', { payEnabled, allowCounter, hours }).then((s) => {
      this.setData(Object.assign({ saving: false }, s))
      wx.showToast({ title: '已保存', icon: 'success' })
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  }
})
