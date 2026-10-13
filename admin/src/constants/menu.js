/**
 * 后台菜单结构 + 角色可见性
 *
 * ⚠️ 「谁能看哪个页面」的唯一事实来源是 `page-matrix.json`，本文件只负责**结构**（顺序、分组、图标）。
 *   加一个新页面必须同时改两处：`page-matrix.json`（角色 + 依赖接口）+ 下面的 MENUS（摆放位置）。
 *   验收脚本 `server/tests/role-agent/batch2-admin-roles-check.js` 会比对两边是否一致。
 *
 * ⚠️ 前端显隐**不是权限防线**：真正的拦截在后端 roleRules。这里只为「别让用户点了才发现 403」。
 */
import PAGE_MATRIX from './page-matrix.json'

/** 页面矩阵：路径 → { title, roles, must, optional, menu, group, icon, warehouseCode, homeOf } */
export const PAGES = PAGE_MATRIX.pages

/** 系统全部角色（与后端 user.js VALID_ROLES 一致） */
export const ALL_ROLES = ['out', 'purchase', 'storekeeper', 'director', 'boss', 'admin']

/**
 * 侧边栏结构（顺序 = 显示顺序）。
 * leaf  ：{ path }
 * group ：{ key, title, icon, children: [path] }
 */
export const MENUS = [
  { path: '/dashboard' },
  { path: '/screen' },
  {
    key: 'stats',
    title: '数据统计',
    icon: 'TrendCharts',
    children: ['/stats/overview', '/stats/monthly', '/stats/material-rank', '/stats/operator-stats']
  },
  { path: '/user/list' },
  { path: '/role/list' },
  {
    key: 'material',
    title: '物料管理',
    icon: 'Box',
    children: ['/material/parts', '/material/product', '/material/import']
  },
  {
    key: 'order',
    title: '单据管理',
    icon: 'Document',
    children: ['/order/outbound', '/order/inbound', '/order/inbound-create', '/order/outbound-create']
  },
  // 采购任务移到一级（2026-10-12 用户要求）：高频操作，不该埋在单据管理里
  { path: '/order/purchase-tasks' },
  { path: '/message/list' },
  { path: '/check/list' },
  { path: '/setting/company' },
  { path: '/system/logs' }
]

/** 落在首页时的角色优先级（多角色账号取最靠前的那个） */
const HOME_PRIORITY = ['boss', 'admin', 'director', 'storekeeper', 'purchase', 'out']

/** 取页面元信息；未登记的路径返回 null */
export function pageMeta(path) {
  return PAGES[path] || null
}

/**
 * 该角色集合能否进入某个路由。
 * - 未登记的路径 → 放行（交给路由自身处理，避免误伤）
 * - roles 为空数组 → 不限制（如消息中心、修改密码）
 */
export function canAccessPath(path, roles = []) {
  const meta = PAGES[path]
  if (!meta) return true
  if (!meta.roles || meta.roles.length === 0) return true
  return roles.some((r) => meta.roles.includes(r))
}

/**
 * 按角色 + 所管仓库过滤出侧边栏。
 * @param {string[]} roles 当前用户角色
 * @param {string[]|null} warehouseCodes 该用户能看的仓库 code（peijian/chengpin）；
 *        传 null 或空数组 = 不做仓库过滤（老板/管理员/厂长，或仓库列表还没加载出来）
 */
export function buildMenu(roles = [], warehouseCodes = null) {
  const warehouseFilter = Array.isArray(warehouseCodes) && warehouseCodes.length ? warehouseCodes : null

  const keep = (path) => {
    if (!canAccessPath(path, roles)) return false
    const meta = PAGES[path]
    if (!meta) return false
    // 仓库维度：配件仓管只看到「配件仓物料」，成品仓管只看到「成品仓物料」
    //   —— warehouse_ids 为空表示「不隔离」，所以只在真配了仓库时才过滤
    if (meta.warehouseCode && warehouseFilter) {
      return warehouseFilter.includes(meta.warehouseCode)
    }
    return true
  }

  const out = []
  for (const item of MENUS) {
    if (item.path) {
      if (keep(item.path)) out.push({ type: 'item', path: item.path })
      continue
    }
    const children = (item.children || []).filter(keep).map((p) => ({ type: 'item', path: p }))
    // 分组里一个子项都没有 → 整组不显示（免得出现点开是空的「物料管理」）
    if (children.length) {
      out.push({ type: 'group', key: item.key, title: item.title, icon: item.icon, children })
    }
  }
  return out
}

/**
 * 该角色的落地首页。
 * 优先取 page-matrix 里声明了 homeOf 的页面；没有就退到「第一个能看的菜单项」。
 */
export function roleHome(roles = []) {
  for (const role of HOME_PRIORITY) {
    if (!roles.includes(role)) continue
    const hit = Object.keys(PAGES).find((p) => (PAGES[p].homeOf || []).includes(role))
    if (hit) return hit
  }
  const first = MENUS.flatMap((m) => (m.path ? [m.path] : m.children || [])).find((p) =>
    canAccessPath(p, roles)
  )
  return first || '/message/list'
}
