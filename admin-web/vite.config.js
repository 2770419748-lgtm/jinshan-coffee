import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base 用相对路径，打包后的 dist 放到静态网站托管的任何目录都能打开
// --mode mock 时打开本地预览模式，接口走 mock 服务器
// --mode demo 是在线预览，接口走页面里的 demo-backend.js
const MODES = {
  mock: { 'import.meta.env.VITE_MOCK': JSON.stringify('1') },
  demo: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') }
}

const demoBackend = {
  name: 'demo-backend',
  transformIndexHtml: (html) => html.replace('<script src="./config.js"></script>', '<script src="./config.js"></script>\n    <script src="./demo-backend.js"></script>')
}

export default defineConfig(({ mode }) => ({
  base: './',
  define: MODES[mode] || {},
  plugins: mode === 'demo' ? [vue(), demoBackend] : [vue()],
  server: {
    proxy: { '/mock': 'http://localhost:8787' }
  },
  // 打包结果只用 ASCII，静态托管不带编码头也不会乱码
  esbuild: { charset: 'ascii' },
  build: {
    chunkSizeWarningLimit: 2000
  }
}))
