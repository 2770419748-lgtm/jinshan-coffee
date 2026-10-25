// 图片存在服务器硬盘上（配置里的 uploadDir），网址是 /uploads/... 。数据库里也只存 /uploads/ 开头的路径，换域名不受影响。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PREFIX = '/uploads/'
const FOLDER_RE = /^[a-z0-9-]{1,32}$/
const SAFE_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/

// 看文件头判断是不是图片，返回扩展名；不是图片返回 ''
function imageExt(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return ''
}

function month() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 7).replace('-', '')
}

function createStorage({ dir }) {
  const root = path.resolve(dir)

  // /uploads/a/b.jpg → 硬盘上的路径；不在 uploadDir 里面的一律不认
  function resolve(fileID) {
    if (typeof fileID !== 'string' || fileID.indexOf(PREFIX) !== 0) return null
    const rel = fileID.slice(PREFIX.length)
    if (!SAFE_PATH_RE.test(rel) || rel.split('/').some((p) => !p || p === '.' || p === '..')) return null
    const file = path.resolve(root, rel)
    return file.indexOf(root + path.sep) === 0 ? file : null
  }

  function write(rel, buffer) {
    const file = path.resolve(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buffer)
    return PREFIX + rel
  }

  // 员工上传的图片：folder 是 products、covers 这类分类
  function saveImage(buffer, folder) {
    const ext = imageExt(buffer)
    if (!ext) throw new Error('not an image')
    const f = FOLDER_RE.test(folder || '') ? folder : 'misc'
    return write(f + '/' + month() + '/' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex') + '.' + ext, buffer)
  }

  // 给业务代码用（原来云开发的 uploadFile），比如生成的桌码图片
  async function upload({ cloudPath, fileContent }) {
    const rel = String(cloudPath || '')
    if (!SAFE_PATH_RE.test(rel) || rel.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('bad cloudPath ' + rel)
    return { fileID: write(rel, Buffer.from(fileContent)) }
  }

  async function remove({ fileList }) {
    return {
      fileList: (fileList || []).map((fileID) => {
        const file = resolve(fileID)
        if (!file) return { fileID, status: -1 }
        try {
          fs.unlinkSync(file)
        } catch (e) {
          if (e.code !== 'ENOENT') return { fileID, status: -1 }
        }
        return { fileID, status: 0 }
      })
    }
  }

  return { root, resolve, saveImage, upload, remove }
}

module.exports = { createStorage, imageExt, PREFIX }
