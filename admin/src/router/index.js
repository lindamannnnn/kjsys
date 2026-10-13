import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getAccessToken } from '@/api'
import { PAGES, canAccessPath, roleHome } from '@/constants/menu'
import { allowsWarehouse } from '@/constants/warehouse-scope'

/** 路由 meta 统一从 page-matrix.json 取（title / roles），避免两处写两套角色 */
function meta(path, extra = {}) {
  const p = PAGES[path] || {}
  return { title: p.title, roles: p.roles || [], ...extra }
}

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/login.vue'),
    meta: { title: '登录', roles: null } // null = 不需要角色（未登录也能看）
  },
  {
    // 数据大屏：**故意放在 Layout 之外**（全屏、不占侧边栏），自带深色底
    path: '/screen',
    name: 'Screen',
    component: () => import('../views/screen/index.vue'),
    meta: meta('/screen')
  },
  {
    path: '/',
    name: 'Layout',
    component: () => import('../views/Layout.vue'),
    // 登录后落到「这个角色自己的首页」，不再一律跳 /dashboard
    // （仓管/采购点进 /dashboard 会 403，等于一登录就看到报错）
    redirect: () => roleHome(currentRoles()),
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../views/dashboard.vue'),
        meta: meta('/dashboard')
      },
      {
        path: 'stats/overview',
        name: 'StatsOverview',
        component: () => import('../views/stats/overview.vue'),
        meta: meta('/stats/overview')
      },
      {
        path: 'stats/monthly',
        name: 'StatsMonthly',
        component: () => import('../views/stats/monthly.vue'),
        meta: meta('/stats/monthly')
      },
      {
        path: 'stats/material-rank',
        name: 'MaterialRank',
        component: () => import('../views/stats/material-rank.vue'),
        meta: meta('/stats/material-rank')
      },
      {
        path: 'stats/operator-stats',
        name: 'OperatorStats',
        component: () => import('../views/stats/operator-stats.vue'),
        meta: meta('/stats/operator-stats')
      },
      {
        path: 'user/list',
        name: 'UserList',
        component: () => import('../views/user/list.vue'),
        meta: meta('/user/list')
      },
      {
        path: 'user/password',
        name: 'UserPassword',
        component: () => import('../views/user/password.vue'),
        meta: meta('/user/password')
      },
      {
        path: 'role/list',
        name: 'RoleList',
        component: () => import('../views/role/list.vue'),
        meta: meta('/role/list')
      },
      {
        // 全部物料（不锁仓库）—— 供数据看板「预警」跳转、以及编辑/导入后返回使用，不出现在左侧菜单
        path: 'material/list',
        name: 'MaterialList',
        component: () => import('../views/material/list.vue'),
        meta: meta('/material/list')
      },
      {
        // 配件仓 · 物料列表（左侧菜单入口一）
        path: 'material/parts',
        name: 'MaterialParts',
        component: () => import('../views/material/list.vue'),
        meta: meta('/material/parts', { warehouseCode: 'peijian' })
      },
      {
        // 成品仓 · 物料列表（左侧菜单入口二）
        path: 'material/product',
        name: 'MaterialProduct',
        component: () => import('../views/material/list.vue'),
        meta: meta('/material/product', { warehouseCode: 'chengpin' })
      },
      {
        path: 'material/edit',
        name: 'MaterialEdit',
        component: () => import('../views/material/edit.vue'),
        meta: meta('/material/edit')
      },
      {
        path: 'material/import',
        name: 'MaterialImport',
        component: () => import('../views/material/import.vue'),
        meta: meta('/material/import')
      },
      {
        path: 'order/outbound',
        name: 'OrderOutbound',
        component: () => import('../views/order/outbound.vue'),
        meta: meta('/order/outbound')
      },
      {
        path: 'order/inbound',
        name: 'OrderInbound',
        component: () => import('../views/order/inbound.vue'),
        meta: meta('/order/inbound')
      },
      {
        // 新建入库单（2026-10-10 第三批）：对应小程序「入库登记」，仓管/admin 开单
        path: 'order/inbound-create',
        name: 'OrderInboundCreate',
        component: () => import('../views/order/inbound-create.vue'),
        meta: meta('/order/inbound-create')
      },
      {
        // 新建出库单（2026-10-10 第三批）：对应小程序「成品仓出库」，厂长/admin 开单
        // 厂长进来锁死成品仓（页面内判角色），后端 assertDirectorWarehouse 再守一次
        path: 'order/outbound-create',
        name: 'OrderOutboundCreate',
        component: () => import('../views/order/outbound-create.vue'),
        meta: meta('/order/outbound-create')
      },
      {
        // 采购任务（P4 采购线）：仓管发布 → 采购员领取并录实际单价 → 仓管收料入库
        path: 'order/purchase-tasks',
        name: 'PurchaseTasks',
        component: () => import('../views/purchase/tasks.vue'),
        meta: meta('/order/purchase-tasks')
      },
      {
        // 消息中心（V2 新增，与小程序 pages/message/list 对应）
        path: 'message/list',
        name: 'MessageList',
        component: () => import('../views/message/list.vue'),
        meta: meta('/message/list')
      },
      {
        path: 'check/create',
        name: 'CheckCreate',
        component: () => import('../views/check/create.vue'),
        meta: meta('/check/create')
      },
      {
        path: 'check/list',
        name: 'CheckList',
        component: () => import('../views/check/list.vue'),
        meta: meta('/check/list')
      },
      {
        path: 'setting/company',
        name: 'SettingCompany',
        component: () => import('../views/setting/company.vue'),
        meta: meta('/setting/company')
      },
      {
        path: 'system/logs',
        name: 'SystemLogs',
        component: () => import('../views/system/logs.vue'),
        meta: meta('/system/logs')
      }
    ]
  },
  {
    /**
     * 兜底：谁把 URL 敲错了（或收藏了一个已下线的页面）就送回他自己的首页。
     * ⚠️ 没有这条时 vue-router 匹配不到任何路由 → 整个 <router-view> 空白 = **白屏**，
     *    用户看到的就是「网站挂了」。
     *    放在最后，保证不影响任何真实路由。
     */
    path: '/:pathMatch(.*)*',
    redirect: () => roleHome(currentRoles())
  }
]

const router = createRouter({
  // base 必须跟随 vite 的 base：
  //   开发时 BASE_URL = '/'，生产构建时 = '/admin/'（见 vite.config.js）
  // 若写死 createWebHistory()，部署到 /admin/ 后路由匹配不到任何页面 → 整站白屏
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

/** 「必须改密」标记的存储键，与 store/user.js 保持一致 */
const MUST_CHANGE_KEY = 'must_change_password'

/**
 * 从本地存储读当前角色。
 * ⚠️ 守卫里**不能**用 pinia store：router 的首次导航可能早于 pinia 安装完成。
 *    store/user.js 落盘的 user_info 就是同一份数据。
 */
function currentRoles() {
  try {
    const info = JSON.parse(localStorage.getItem('user_info') || 'null')
    return (info && info.roles) || []
  } catch (e) {
    return []
  }
}

router.beforeEach((to, from, next) => {
  document.title = to.meta.title ? `${to.meta.title} - 胜龙进销存` : '胜龙进销存'

  const hasToken = !!getAccessToken()

  // 未登录 → 登录页
  if (!hasToken && to.path !== '/login') {
    next({ path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : undefined })
    return
  }

  const roles = currentRoles()

  // 已登录访问登录页 → 自己的首页
  if (hasToken && to.path === '/login') {
    next(roleHome(roles))
    return
  }

  // 初始密码未改：除改密页外一律先去改密（否则其它接口会 403，用户会以为是系统坏了）
  if (hasToken && to.path !== '/user/password') {
    if (localStorage.getItem(MUST_CHANGE_KEY) === '1') {
      next({ path: '/user/password', replace: true })
      return
    }
  }

  /*
   * 角色门：这个角色不该进的页面直接挡掉，送回他自己的首页。
   * ⚠️ 这只是体验层（防止菜单藏了但有人手敲 URL）；真正的权限在后端 roleRules，
   *    就算绕过这里，接口一样会 403。
   */
  if (hasToken && !canAccessPath(to.path, roles)) {
    const home = roleHome(roles)
    if (to.path !== home) {
      ElMessage.warning('当前账号没有这个页面的权限，已回到你的首页')
      next({ path: home, replace: true })
      return
    }
  }

  /*
   * 仓库门：page-matrix 里声明了 warehouseCode 的页面只对该仓开放。
   * 起因（2026-10-12 用户要求）：采购任务只针对**配件仓**（成品是车间做的，不用采购），
   *   但角色门只认角色 —— 纯成品仓后台（也是 storekeeper）手敲 URL 一样能进，
   *   于是这里再按「他管的仓」挡一道。
   * ⚠️ 还是体验层：真防线是后端（purchase.list 只返回自己仓的任务）。
   *    判定用 localStorage 缓存（守卫同步执行，等不了接口）；缓存为空 → 按「不隔离」放行，
   *    宁可放进去看到空列表，也不要把入口误挡。
   */
  if (hasToken) {
    const requiredCode = (PAGES[to.path] || {}).warehouseCode
    if (requiredCode && !allowsWarehouse(requiredCode)) {
      const home = roleHome(roles)
      // 万一他的首页就是这个页面（page-matrix 的 homeOf，如采购员）→ 放行，
      // 否则会把人挡在门外、又无家可归（死循环式「回首页」提示）
      if (to.path !== home) {
        ElMessage.warning('这个页面不属于你管的仓库，已回到你的首页')
        next({ path: home, replace: true })
        return
      }
    }
  }

  next()
})

export default router
