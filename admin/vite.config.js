import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  // 生产构建挂到 API 服务的 /admin/ 子路径下（dev 时保持根路径不变）
  base: command === 'build' ? '/admin/' : '/',
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
}))
