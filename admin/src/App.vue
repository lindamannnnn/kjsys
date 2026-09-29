<template>
  <router-view />
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'

const router = useRouter()
const userStore = useUserStore()

/**
 * 登录失效统一处理
 * api/index.js 收到 401 时会派发 window 事件 'auth:expired'
 */
function handleAuthExpired() {
  userStore.logout()
  ElMessage.warning('登录已过期，请重新登录')

  if (router.currentRoute.value.path !== '/login') {
    router.replace({
      path: '/login',
      query: { redirect: router.currentRoute.value.fullPath }
    })
  }
}

onMounted(() => {
  window.addEventListener('auth:expired', handleAuthExpired)
})

onUnmounted(() => {
  window.removeEventListener('auth:expired', handleAuthExpired)
})
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background-color: #f5f7fa;
}

#app {
  min-height: 100vh;
}
</style>
