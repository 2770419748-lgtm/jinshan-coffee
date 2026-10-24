// 在线预览用的 crypto 替身：只实现云函数用到的几个方法。scrypt 换成了 SHA-256，只能用来演示
const { Buffer } = require('buffer')
const sha256hex = require('./sha256')

function randomBytes(n) {
  const bytes = new Uint8Array(n)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes)
}

function createHash() {
  let text = ''
  return {
    update(s) {
      text += s
      return this
    },
    digest() {
      return sha256hex(text)
    }
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length')
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function scrypt(password, salt, keylen, callback) {
  setTimeout(() => callback(null, Buffer.from(sha256hex(salt + ':' + password), 'hex').slice(0, keylen)), 0)
}

module.exports = { randomBytes, createHash, timingSafeEqual, scrypt }
