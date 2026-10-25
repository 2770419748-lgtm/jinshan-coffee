// 订阅消息：出餐通知、借书到期提醒。微信规定只能在顾客点按钮时问，点一次「允许」只能收一条，所以每次下单都问一次。
// ask 返回 Promise<boolean>：顾客允许了是 true；没配模板、不允许、微信版本太旧都是 false，照常下单
function ask(templateId) {
  return new Promise((resolve) => {
    if (!templateId || typeof wx.requestSubscribeMessage !== 'function') {
      resolve(false)
      return
    }
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (res) => resolve(res[templateId] === 'accept'),
      fail: () => resolve(false)
    })
  })
}

module.exports = { ask }
