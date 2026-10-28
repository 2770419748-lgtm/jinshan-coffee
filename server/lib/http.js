// HTTP 小工具：读请求体（限大小）、解析上传的文件（multipart/form-data）、发 JSON、发静态文件
const fs = require('fs')
const path = require('path')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        reject(new HttpError(413, 'too large'))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit)
  try {
    const value = JSON.parse(buf.toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch (e) {
    throw new HttpError(400, 'bad json')
  }
}

// 取出上传的第一个文件；wx.uploadFile 和浏览器的 FormData 都是这种格式
function firstFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '')
  if (!m) return null
  const delim = Buffer.from('--' + (m[1] || m[2]))
  let pos = buf.indexOf(delim)
  while (pos !== -1) {
    pos += delim.length
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break
    const headerEnd = buf.indexOf('\r\n\r\n', pos)
    if (headerEnd === -1) break
    const headers = buf.subarray(pos, headerEnd).toString('utf8')
    const next = buf.indexOf(delim, headerEnd + 4)
    if (next === -1) break
    if (/filename=/i.test(headers)) return buf.subarray(headerEnd + 4, next - 2)
    pos = next
  }
  return null
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

// 发 root 目录下的文件；不在 root 里面的路径一律 404
function sendFile(req, res, root, rel, cache) {
  const base = path.resolve(root)
  const file = path.resolve(base, '.' + path.sep + rel)
  if (file !== base && file.indexOf(base + path.sep) !== 0) return false
  let stat
  try {
    stat = fs.statSync(file)
  } catch (e) {
    return false
  }
  if (!stat.isFile()) return false
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache || 'no-cache'
  })
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(file).pipe(res)
  return true
}

module.exports = { HttpError, readBody, readJson, firstFile, sendJson, sendFile, TYPES }
