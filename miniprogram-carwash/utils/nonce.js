// 请求号：同一次操作连点两下、网络重发时，服务器只处理一次（扣次卡用）
function nonce() {
  let s = Date.now().toString(36)
  while (s.length < 24) s += Math.floor(Math.random() * 36).toString(36)
  return s
}

module.exports = nonce
