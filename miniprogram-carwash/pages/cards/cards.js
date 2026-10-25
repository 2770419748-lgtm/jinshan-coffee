const api = require('../../utils/api')

Page({
  data: {
    cards: [],
    openId: '',
    logs: [],
    loaded: false
  },

  onShow() {
    api.carwash('myCards').then((res) => this.setData({ cards: res.cards, loaded: true })).catch((err) => {
      this.setData({ loaded: true })
      api.toastError(err)
    })
  },

  // 点一张卡展开它的使用记录
  toggle(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.openId === id) {
      this.setData({ openId: '', logs: [] })
      return
    }
    api.carwash('myCardLogs', { cardId: id }).then((res) => this.setData({ openId: id, logs: res.logs })).catch(api.toastError)
  }
})
