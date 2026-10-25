import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 网页后台由服务器在 /admin/ 下提供；base 用相对路径，放在哪个目录下都能打开
// --mode mock 时打开本地预览模式（npm run mock）：接口连本机用假数据跑的服务器
const MODES = {
  mock: { 'import.meta.env.VITE_MOCK': JSON.stringify('1') }
}

export default defineConfig(({ mode }) => ({
  base: './',
  define: MODES[mode] || {},
  plugins: [vue()],
  // npm run dev 时接口转给 npm run mock 起的服务器
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/uploads': 'http://localhost:8787',
      '/mock': 'http://localhost:8787'
    }
  },
  // 打包结果只用 ASCII，服务器不带编码头也不会乱码
  esbuild: { charset: 'ascii' },
  build: {
    chunkSizeWarningLimit: 2000
  }
}))
