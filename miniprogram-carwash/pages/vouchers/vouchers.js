const api = require('../../utils/api')

Page({
  data: {
    usable: [],
    others: [],
    loaded: false
  },

  onShow() {
    api.carwash('myVouchers').then((res) => this.setData({ usable: res.usable, others: res.others, loaded: true })).catch((err) => {
      this.setData({ loaded: true })
      api.toastError(err)
    })
  }
})
