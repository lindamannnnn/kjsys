<template>
  <div class="layout-container">
    <!-- 侧边栏：菜单按「角色 + 所管仓库」过滤，配件仓管登录后只会看到配件仓的东西 -->
    <aside class="sidebar">
      <div class="logo">
        <h2>胜龙进销存</h2>
        <p>{{ consoleName }}</p>
      </div>

      <el-menu
        :default-active="activeMenu"
        class="sidebar-menu"
        background-color="#1a1a2e"
        text-color="#a0a0b0"
        active-text-color="#ffffff"
        router
      >
        <template v-for="item in menuItems">
          <!-- 分组：一个子项都没有时整组不渲染（在 buildMenu 里已滤掉） -->
          <el-sub-menu v-if="item.type === 'group'" :key="'g-' + item.key" :index="'g-' + item.key">
            <template #title>
              <el-icon><component :is="iconOf(item.icon)" /></el-icon>
              <span>{{ item.title }}</span>
            </template>
            <el-menu-item v-for="child in item.children" :key="child.path" :index="child.path">
              <span v-if="dotOf(child.path)" :class="['wh-dot', dotOf(child.path)]"></span>
              {{ titleOf(child.path) }}
            </el-menu-item>
          </el-sub-menu>

          <el-menu-item v-else :key="item.path" :index="item.path">
            <el-icon><component :is="iconOf(metaOf(item.path).icon)" /></el-icon>
            <span>{{ titleOf(item.path) }}</span>
          </el-menu-item>
        </template>
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
          <el-tag v-if="scopeLabel" type="info" size="small" effect="plain" class="scope-tag">
            {{ scopeLabel }}
          </el-tag>
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
                <el-dropdown-item disabled>身份：{{ consoleName }}</el-dropdown-item>
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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import { ROLE_MAP } from '@/constants/roles'
import { buildMenu, pageMeta } from '@/constants/menu'
import { cacheWarehouseCodes, resolveWarehouseCodes } from '@/constants/warehouse-scope'
import { warehouseApi } from '@/api'
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
  ArrowDown,
  Bell,
  Monitor,
  ShoppingCart
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const activeMenu = computed(() => route.path)
const currentRoute = computed(() => route)

/** 菜单图标按名字取（page-matrix.json 里存的是字符串，不能直接放组件） */
const ICONS = {
  DataAnalysis,
  TrendCharts,
  User,
  Lock,
  Box,
  Document,
  Checked,
  Setting,
  Tickets,
  Bell,
  Monitor,
  ShoppingCart
}
function iconOf(name) {
  return ICONS[name] || Box
}

const metaOf = (path) => pageMeta(path) || {}
const titleOf = (path) => metaOf(path).title || path
const dotOf = (path) => {
  const dot = metaOf(path).dot
  return dot ? `wh-dot--${dot}` : ''
}

const warehouses = ref([])

/**
 * 该用户「能看的仓库 code」（判定口径统一在 constants/warehouse-scope.js）。
 * - warehouse_ids 为空 = 不隔离（老板/管理员），返回 null 表示不做仓库过滤
 * - 仓库列表还没加载出来也返回 null —— 宁可多显示一个菜单，也别把人家的入口藏没了
 */
const myWarehouseCodes = computed(() =>
  resolveWarehouseCodes(userStore.userInfo, warehouses.value)
)

/**
 * 把结果缓存到 localStorage：路由守卫要**同步**判定（防手敲 URL 进成品仓账号
 * 看不到的页面，比如采购任务），而守卫跑在任何组件挂载之前、没法等接口。
 */
watch(
  [() => userStore.userInfo, warehouses],
  () => cacheWarehouseCodes(userStore.userInfo, warehouses.value),
  { immediate: true, deep: false }
)

const menuItems = computed(() => buildMenu(userStore.roles || [], myWarehouseCodes.value))

/** 顶部显示的「所管仓库」，让仓管一眼知道自己在哪个仓的界面里 */
const scopeLabel = computed(() => {
  const ids = (userStore.userInfo && userStore.userInfo.warehouse_ids) || []
  if (!Array.isArray(ids) || !ids.length) return ''
  const names = warehouses.value
    .filter((w) => ids.map(Number).includes(Number(w._id !== undefined ? w._id : w.id)))
    .map((w) => w.name)
  return names.join('、')
})

/** 当前这套菜单是哪套后台（给用户一个「我进对地方了」的确认） */
const consoleName = computed(() => {
  const roles = userStore.roles || []
  const codes = myWarehouseCodes.value || []
  if (roles.includes('admin')) return '后台管理系统'
  if (roles.includes('boss')) return '经营看板'
  if (roles.includes('director')) return '厂长后台'
  if (roles.includes('storekeeper')) {
    if (codes.length === 1) return codes[0] === 'peijian' ? '配件仓后台' : '成品仓后台'
    return '仓库后台'
  }
  if (roles.includes('purchase')) return '采购后台'
  return '后台管理系统'
})

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

onMounted(async () => {
  // 只为「按仓库收敛菜单」用；失败不影响任何功能（myWarehouseCodes 会退回 null = 不过滤）
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
  } catch (err) {
    console.warn('加载仓库列表失败（菜单将不做仓库过滤）:', err.message)
  }
})
</script>

<style scoped>
.layout-container {
  display: flex;
  /* --app-h 由 utils/viewport-fit.js 同步；取不到时退回 100vh */
  min-height: var(--app-h, 100vh);
}

.sidebar {
  width: 220px;
  background: #1a1a2e;
  color: #fff;
  position: fixed;
  /* 同上：跟随实际可见高度，而不是只看 layout viewport 的 vh */
  height: var(--app-h, 100vh);
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

.scope-tag {
  cursor: default;
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
