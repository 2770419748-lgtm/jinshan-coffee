// 调用云函数，统一处理返回格式 { ok, data, msg, code }
function call(name, action, data) {
  return wx.cloud.callFunction({
    name,
    data: Object.assign({ action }, data || {})
  }).then((res) => {
    const result = res.result || {}
    if (!result.ok) {
      const err = new Error(result.msg || '操作失败')
      err.code = result.code
      throw err
    }
    return result.data
  })
}

function errorText(err) {
  if (err && err.code) return err.message
  const raw = String((err && (err.errMsg || err.message)) || '')
  if (/FunctionName|FUNCTION_NOT_FOUND|-501000/i.test(raw)) return '云函数还没部署'
  if (/env|-501001/i.test(raw)) return '云开发环境没配置好'
  return '网络不太好，请稍后再试'
}

function toastError(err) {
  if (err && !err.code) console.error(err)
  wx.showToast({ title: errorText(err), icon: 'none', duration: 2500 })
}

module.exports = {
  common: (action, data) => call('common', action, data),
  coffee: (action, data) => call('coffee', action, data),
  errorText,
  toastError
}
