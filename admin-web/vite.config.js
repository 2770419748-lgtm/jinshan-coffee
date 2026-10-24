import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base 用相对路径，打包后的 dist 放到静态网站托管的任何目录都能打开
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    proxy: { '/mock': 'http://localhost:8787' }
  },
  build: {
    chunkSizeWarningLimit: 2000
  }
})
