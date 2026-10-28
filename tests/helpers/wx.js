// 测试微信接口用的小工具：假的 fetch、按微信支付格式加密通知
const crypto = require('crypto')

const API_V3_KEY = 'abcdefghijklmnopqrstuvwxyz012345'

// 假的 fetch：按顺序返回准备好的响应（之后还能往 fn.queue 里加），并记下请求
function fakeFetch(responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init: init || {} })
    const r = responses.shift()
    if (!r) throw new Error('unexpected request ' + url)
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    return {
      status: r.status || 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? r.type || 'application/json' : null) },
      text: async () => body.toString('utf8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
    }
  }
  fn.calls = calls
  fn.queue = responses
  return fn
}

// 按微信支付的格式加密一段通知内容
function encryptNotify(data, key) {
  const nonce = crypto.randomBytes(6).toString('hex')
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key || API_V3_KEY), Buffer.from(nonce))
  cipher.setAAD(Buffer.from('transaction'))
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return JSON.stringify({
    id: 'evt1',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext: enc.toString('base64'), associated_data: 'transaction', original_type: 'transaction', nonce }
  })
}

module.exports = { fakeFetch, encryptNotify, API_V3_KEY }
