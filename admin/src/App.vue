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

onMounted(async () => {
  window.addEventListener('auth:expired', handleAuthExpired)

  /*
   * 启动时静默刷新一次用户信息。
   * ------------------------------------------------------------
   * 起因（2026-10-21）：userStore.userInfo 只在登录那一刻写入 localStorage，之后再不更新。
   *   于是「后台把某人从配件仓调到成品仓」「后补了角色」这类改动，
   *   只要用户不退出重登，浏览器里永远是旧快照 —— 表现为菜单多一个/少一个、
   *   仓管看到别仓的入口。这里每次进系统都拉一次最新的，刷新页面即生效。
   * 失败不影响任何功能：refresh() 内部已处理（401 会走 auth:expired 登出）。
   */
  try {
    await userStore.refresh()
  } catch (e) {
    /* 静默失败：拿不到就沿用本地快照，不打扰用户 */
  }
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
  /* --app-h 由 utils/viewport-fit.js 同步；取不到时退回 100vh */
  min-height: var(--app-h, 100vh);
}
</style>
