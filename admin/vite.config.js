import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 后端接口占用 3000，后台开发服务器改用 5173
    port: 5173,
    open: true
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  }
})
