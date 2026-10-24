// 打包在线预览的“后端”：云函数 + 内存数据库，跑在浏览器里
import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', process.argv[2] || 'dist-demo', 'demo-backend.js')

await build({
  entryPoints: [path.join(here, 'backend.js')],
  outfile: out,
  bundle: true,
  format: 'iife',
  globalName: 'JinshanDemo',
  platform: 'browser',
  target: 'es2019',
  minify: true,
  charset: 'ascii',
  alias: {
    'wx-server-sdk': path.join(here, '..', '..', 'tests', 'helpers', 'fake-cloud.js'),
    crypto: path.join(here, 'shims', 'crypto.js'),
    util: path.join(here, 'shims', 'util.js')
  },
  inject: [path.join(here, 'shims', 'buffer-global.js')],
  define: {
    'process.env.OWNER_CODE': 'undefined',
    'process.env.TCB_ENV': 'undefined',
    'process.env.SCF_NAMESPACE': 'undefined'
  },
  logLevel: 'warning'
})
console.log('在线预览后端：' + out)
