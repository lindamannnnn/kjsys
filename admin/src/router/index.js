import { createRouter, createWebHistory } from 'vue-router'
import { getAccessToken } from '@/api'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/login.vue'),
    meta: { title: '登录' }
  },
  {
    path: '/',
    name: 'Layout',
    component: () => import('../views/Layout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../views/dashboard.vue'),
        meta: { title: '数据看板' }
      },
      {
        path: 'stats/overview',
        name: 'StatsOverview',
        component: () => import('../views/stats/overview.vue'),
        meta: { title: '出入库统计' }
      },
      {
        path: 'stats/material-rank',
        name: 'MaterialRank',
        component: () => import('../views/stats/material-rank.vue'),
        meta: { title: '物料排行' }
      },
      {
        path: 'stats/operator-stats',
        name: 'OperatorStats',
        component: () => import('../views/stats/operator-stats.vue'),
        meta: { title: '人员绩效' }
      },
      {
        path: 'user/list',
        name: 'UserList',
        component: () => import('../views/user/list.vue'),
        meta: { title: '用户管理' }
      },
      {
        path: 'user/password',
        name: 'UserPassword',
        component: () => import('../views/user/password.vue'),
        meta: { title: '修改密码' }
      },
      {
        path: 'role/list',
        name: 'RoleList',
        component: () => import('../views/role/list.vue'),
        meta: { title: '角色管理' }
      },
      {
        // 全部物料（不锁仓库）—— 供数据看板「预警」跳转、以及编辑/导入后返回使用，不出现在左侧菜单
        path: 'material/list',
        name: 'MaterialList',
        component: () => import('../views/material/list.vue'),
        meta: { title: '物料列表' }
      },
      {
        // 配件仓 · 物料列表（左侧菜单入口一）
        path: 'material/parts',
        name: 'MaterialParts',
        component: () => import('../views/material/list.vue'),
        meta: { title: '配件仓物料', warehouseCode: 'peijian' }
      },
      {
        // 成品仓 · 物料列表（左侧菜单入口二）
        path: 'material/product',
        name: 'MaterialProduct',
        component: () => import('../views/material/list.vue'),
        meta: { title: '成品仓物料', warehouseCode: 'chengpin' }
      },
      {
        path: 'material/edit',
        name: 'MaterialEdit',
        component: () => import('../views/material/edit.vue'),
        meta: { title: '编辑物料' }
      },
      {
        path: 'material/import',
        name: 'MaterialImport',
        component: () => import('../views/material/import.vue'),
        meta: { title: '批量导入' }
      },
      {
        path: 'order/outbound',
        name: 'OrderOutbound',
        component: () => import('../views/order/outbound.vue'),
        meta: { title: '出库单管理' }
      },
      {
        path: 'order/inbound',
        name: 'OrderInbound',
        component: () => import('../views/order/inbound.vue'),
        meta: { title: '入库单管理' }
      },
      {
        path: 'check/create',
        name: 'CheckCreate',
        component: () => import('../views/check/create.vue'),
        meta: { title: '创建盘点' }
      },
      {
        path: 'check/list',
        name: 'CheckList',
        component: () => import('../views/check/list.vue'),
        meta: { title: '盘点管理' }
      },
      {
        path: 'setting/company',
        name: 'SettingCompany',
        component: () => import('../views/setting/company.vue'),
        meta: { title: '系统设置' }
      },
      {
        path: 'system/logs',
        name: 'SystemLogs',
        component: () => import('../views/system/logs.vue'),
        meta: { title: '操作日志' }
      }
    ]
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

router.beforeEach((to, from, next) => {
  document.title = to.meta.title ? `${to.meta.title} - 胜龙进销存` : '胜龙进销存'

  const hasToken = !!getAccessToken()

  // 未登录 → 登录页
  if (!hasToken && to.path !== '/login') {
    next({ path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : undefined })
    return
  }

  // 已登录访问登录页 → 首页
  if (hasToken && to.path === '/login') {
    next('/dashboard')
    return
  }

  // 初始密码未改：除改密页外一律先去改密（否则其它接口会 403，用户会以为是系统坏了）
  if (hasToken && to.path !== '/user/password' && to.path !== '/login') {
    if (localStorage.getItem(MUST_CHANGE_KEY) === '1') {
      next({ path: '/user/password', replace: true })
      return
    }
  }

  next()
})

export default router
