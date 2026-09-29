<template>
  <div class="layout-container">
    <!-- 侧边栏 -->
    <aside class="sidebar">
      <div class="logo">
        <h2>胜龙进销存</h2>
        <p>后台管理系统</p>
      </div>

      <el-menu
        :default-active="activeMenu"
        class="sidebar-menu"
        background-color="#1a1a2e"
        text-color="#a0a0b0"
        active-text-color="#ffffff"
        router
      >
        <el-menu-item index="/dashboard">
          <el-icon><DataAnalysis /></el-icon>
          <span>数据看板</span>
        </el-menu-item>

        <el-sub-menu index="stats">
          <template #title>
            <el-icon><TrendCharts /></el-icon>
            <span>数据统计</span>
          </template>
          <el-menu-item index="/stats/overview">出入库统计</el-menu-item>
          <el-menu-item index="/stats/material-rank">物料排行</el-menu-item>
          <el-menu-item index="/stats/operator-stats">人员绩效</el-menu-item>
        </el-sub-menu>

        <el-menu-item index="/user/list">
          <el-icon><User /></el-icon>
          <span>用户管理</span>
        </el-menu-item>

        <el-menu-item index="/role/list">
          <el-icon><Lock /></el-icon>
          <span>权限管理</span>
        </el-menu-item>

        <el-sub-menu index="material">
          <template #title>
            <el-icon><Box /></el-icon>
            <span>物料管理</span>
          </template>
          <!-- 物料按仓库分开两个入口：配件仓 / 成品仓 -->
          <el-menu-item index="/material/parts">
            <span class="wh-dot wh-dot--parts"></span>配件仓物料
          </el-menu-item>
          <el-menu-item index="/material/product">
            <span class="wh-dot wh-dot--product"></span>成品仓物料
          </el-menu-item>
          <el-menu-item index="/material/import">批量导入</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="order">
          <template #title>
            <el-icon><Document /></el-icon>
            <span>单据管理</span>
          </template>
          <el-menu-item index="/order/outbound">出库单</el-menu-item>
          <el-menu-item index="/order/inbound">入库单</el-menu-item>
        </el-sub-menu>

        <el-menu-item index="/check/list">
          <el-icon><Checked /></el-icon>
          <span>盘点管理</span>
        </el-menu-item>

        <el-menu-item index="/setting/company">
          <el-icon><Setting /></el-icon>
          <span>系统设置</span>
        </el-menu-item>

        <el-menu-item index="/system/logs">
          <el-icon><Tickets /></el-icon>
          <span>操作日志</span>
        </el-menu-item>
      </el-menu>
    </aside>

    <!-- 主内容区 -->
    <main class="main-content">
      <!-- 顶部栏 -->
      <header class="header">
        <div class="breadcrumb">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-if="currentRoute.meta.title">{{ currentRoute.meta.title }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="user-info">
          <el-tag v-if="mustChange" type="danger" size="small" class="change-tip" @click="goPassword">
            请先修改初始密码
          </el-tag>
          <el-dropdown>
            <span class="user-name">
              {{ userStore.displayName }} <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>角色：{{ roleNames }}</el-dropdown-item>
                <el-dropdown-item divided @click="goPassword">
                  <el-icon><Key /></el-icon> 修改密码
                </el-dropdown-item>
                <el-dropdown-item @click="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <!-- 页面内容 -->
      <div class="page-content">
        <router-view />
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import { ROLE_MAP } from '@/constants/roles'
import {
  DataAnalysis,
  TrendCharts,
  User,
  Lock,
  Box,
  Document,
  Checked,
  Setting,
  Tickets,
  Key,
  ArrowDown
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const activeMenu = computed(() => route.path)
const currentRoute = computed(() => route)

const roleNames = computed(() => {
  const list = userStore.roles || []
  if (!list.length) return '无角色'
  return list.map((r) => ROLE_MAP[r]?.label || r).join('、')
})

const mustChange = computed(() => userStore.mustChangePassword)

function goPassword() {
  router.push('/user/password')
}

function logout() {
  userStore.logout()
  ElMessage.success('已退出登录')
  router.replace('/login')
}
</script>

<style scoped>
.layout-container {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 220px;
  background: #1a1a2e;
  color: #fff;
  position: fixed;
  height: 100vh;
  overflow-y: auto;
}

.logo {
  padding: 24px;
  text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.logo h2 {
  font-size: 18px;
  margin-bottom: 4px;
}

.logo p {
  font-size: 12px;
  color: #a0a0b0;
}

.sidebar-menu {
  border-right: none;
  padding-top: 16px;
}

.sidebar-menu :deep(.el-menu-item),
.sidebar-menu :deep(.el-sub-menu__title) {
  height: 48px;
  line-height: 48px;
}

.sidebar-menu :deep(.el-menu-item:hover),
.sidebar-menu :deep(.el-sub-menu__title:hover) {
  background-color: rgba(255, 255, 255, 0.05);
}

.sidebar-menu :deep(.el-menu-item.is-active) {
  background-color: rgba(255, 255, 255, 0.1);
  border-right: 3px solid #8A6A10;
}

/* 物料菜单里区分两个仓库的小圆点 */
.wh-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 8px;
  vertical-align: middle;
}

.wh-dot--parts {
  background: #E6A23C;
}

.wh-dot--product {
  background: #409EFF;
}

.main-content {
  flex: 1;
  margin-left: 220px;
  background: #f5f7fa;
}

.header {
  height: 60px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.breadcrumb {
  font-size: 14px;
}

.user-info {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
}

.change-tip {
  cursor: pointer;
  animation: tip-blink 1.6s ease-in-out infinite;
}

@keyframes tip-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.user-name {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  color: #333;
}

.page-content {
  padding: 24px;
}
</style>
