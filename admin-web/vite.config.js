import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base 用相对路径，打包后的 dist 放到静态网站托管的任何目录都能打开
// --mode mock 时打开本地预览模式，接口走 mock 服务器
export default defineConfig(({ mode }) => ({
  base: './',
  define: mode === 'mock' ? { 'import.meta.env.VITE_MOCK': JSON.stringify('1') } : {},
  plugins: [vue()],
  server: {
    proxy: { '/mock': 'http://localhost:8787' }
  },
  build: {
    chunkSizeWarningLimit: 2000
  }
}))
