/**
 * 「我能看哪个仓」—— 仓库维度的唯一判定来源（前端）
 * ============================================================
 * 为什么单独一个文件：
 *   同一套判定要在三处用 —— 侧边栏过滤（Layout.vue）、看板卡片显隐（dashboard.vue）、
 *   路由守卫（router/index.js，防手敲 URL）。三处各写一遍必然走偏，所以统一放这里。
 *
 * ⚠️ 这只是**体验层**（别让人看到自己用不了的功能）。
 *    真防线是后端 roleRules + services/warehouse.js 的仓库过滤。
 *
 * 口径（与后端 services/warehouse.js 一致）：
 *   - warehouse_ids 为空            → 不做仓库隔离 → 返回 null（老板/管理员/采购/厂长）
 *   - 仓库列表还没加载出来          → 返回 null（宁可多显示一个入口，也别把入口藏没了）
 *   - 有 warehouse_ids 但匹配不上   → 返回 null（同上，保守放行）
 */

/** 缓存键：路由守卫要**同步**读，只能用 localStorage 缓存 */
export const WAREHOUSE_CACHE_KEY = 'warehouse_codes'

/**
 * 算出「自己能看的仓库 code 数组」。
 * @param {object} userInfo  登录返回的用户信息（含 warehouse_codes / warehouse_ids）
 * @param {Array}  warehouses  warehouse.list 返回的仓库数组（已按 warehouse_ids 过滤过）
 * @returns {string[]|null}   null = 不隔离 / 无法判定
 */
export function resolveWarehouseCodes(userInfo, warehouses) {
  /*
   * 首选：后端在登录 / getUserInfo 里直接算好的 warehouse_codes。
   * 语义由后端定：null = 不隔离（admin/boss，或没配仓库），数组 = 只管这些仓。
   *
   * ⚠️ 为什么不能只靠下面的「warehouse_ids ⇄ warehouse.list 匹配」：
   *   那条路依赖**第二个请求**和**localStorage 里的 userInfo 快照**，有两个失效窗口：
   *     ① warehouse.list 还没回来 / 失败 → 这里返回 null → 菜单整块不隔离 → 成品仓管看到「配件仓物料」
   *     ② 后台改了某人的仓库，但浏览器里还是登录时的旧快照 → 按旧值算，永远不更新
   *   实测症状就是「成品仓管看得到配件仓物料、左上角显示仓库后台」。
   *   后端算好后一次拿到，这两个窗口都不存在。
   */
  if (userInfo && Object.prototype.hasOwnProperty.call(userInfo, 'warehouse_codes')) {
    const given = userInfo.warehouse_codes
    if (given === null) return null // 后端明确说「不隔离」
    if (Array.isArray(given) && given.length) return given.filter(Boolean)
    // 后端给了空数组 = 配了 warehouse_ids 但一个仓都对不上 → 按不隔离兜底
    // （宁可多显示一个入口，也不要把人挡在门外；真正的防线是后端 requireWarehouseAccess）
    return null
  }

  // 兼容旧数据（本地缓存里没有 warehouse_codes 字段时走原逻辑）
  const ids = Array.isArray(userInfo && userInfo.warehouse_ids)
    ? userInfo.warehouse_ids.map(Number).filter(Boolean)
    : []
  if (!ids.length) return null
  const list = Array.isArray(warehouses) ? warehouses : []
  if (!list.length) return null
  const mine = new Set(ids)
  const codes = list
    .filter((w) => mine.has(Number(w._id !== undefined ? w._id : w.id)))
    .map((w) => w.code)
    .filter(Boolean)
  return codes.length ? codes : null
}

/** 写入缓存，供路由守卫同步读取（守卫可能跑在任何组件挂载之前） */
export function cacheWarehouseCodes(userInfo, warehouses) {
  try {
    localStorage.setItem(WAREHOUSE_CACHE_KEY, JSON.stringify(resolveWarehouseCodes(userInfo, warehouses)))
  } catch (e) {
    /* 隐私模式等写不进去就算了，守卫会退回「不隔离」 */
  }
}

/** 读缓存；没写过 / 解析失败 / 空数组 → null（= 不隔离，放行） */
export function readCachedWarehouseCodes() {
  try {
    const raw = localStorage.getItem(WAREHOUSE_CACHE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    return Array.isArray(v) && v.length ? v : null
  } catch (e) {
    return null
  }
}

export function clearCachedWarehouseCodes() {
  try {
    localStorage.removeItem(WAREHOUSE_CACHE_KEY)
  } catch (e) {
    /* ignore */
  }
}

/**
 * 某页面要求的仓库（page-matrix 的 warehouseCode）当前用户能不能进。
 * codes 传 null / 空数组（不隔离或还没加载出来）→ 一律放行。
 */
export function allowsWarehouse(requiredCode, codes) {
  if (!requiredCode) return true
  const list = codes === undefined ? readCachedWarehouseCodes() : codes
  if (!list || !list.length) return true
  return list.includes(requiredCode)
}

/**
 * 「采购任务」的作用域（2026-10-12 用户定稿）：
 * 采购只针对**配件仓**，成品仓的货是车间做的、不需要采购。
 * 所以纯成品仓账号（只辖 chengpin）不该看到任何采购任务入口。
 */
export function inPartsScope(codes) {
  return allowsWarehouse('peijian', codes)
}
