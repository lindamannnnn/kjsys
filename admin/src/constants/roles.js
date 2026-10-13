/**
 * 系统固定角色（与后端 user.js VALID_ROLES 保持一致）
 * 角色不支持自定义增删，只能给用户分配这 6 种
 * （原「入库员 in」已按流程重构 V2 并入「仓管员 storekeeper」，2026-10-03；
 *   2026-10-06 新增「厂长 director」）
 */
export const ROLES = [
  {
    value: 'out',
    label: '领料员',
    tag: 'success',
    description: '小程序提交领料单（出库）、查看自己的领料记录'
  },
  {
    value: 'purchase',
    label: '采购员',
    tag: 'info',
    description: '入库登记、查看库存台账与预警清单'
  },
  {
    value: 'storekeeper',
    label: '仓管',
    tag: 'warning',
    description: '确认出入库单据、创建盘点任务、维护物料档案'
  },
  {
    value: 'director',
    label: '厂长',
    tag: 'warning',
    description: '查看两个仓库的库存与金额、发起采购任务、盘点与审核盘点'
  },
  {
    value: 'boss',
    label: '老板',
    tag: 'danger',
    description: '全部数据查看、单据驳回与盘点审核权限'
  },
  {
    value: 'admin',
    label: '管理员',
    tag: 'danger',
    description: '用户、角色、仓库等系统管理权限'
  }
]

export const ROLE_MAP = ROLES.reduce((acc, r) => {
  acc[r.value] = r
  return acc
}, {})

export function roleLabel(role) {
  return (ROLE_MAP[role] && ROLE_MAP[role].label) || role
}

export function roleTag(role) {
  return (ROLE_MAP[role] && ROLE_MAP[role].tag) || 'info'
}

/**
 * 成本价 / 库存价值可见性（2026-10-10）
 *
 * 口径：**仓库端只看数量、不看钱** —— 仓管（成品仓 / 配件仓）的后台不展示
 * 「成本价」「库存价值」；兼任管理类或采购角色时按角色并集放开。
 *
 * ⚠️ 与后端 `server/src/middleware/auth.js` 的 COST_VISIBLE_ROLES 必须保持一致：
 *    前端藏列只是体验，**真正的防线在后端**（仓管调 material.list 拿到的
 *    数据里根本没有 avg_cost）。改这里别忘了改后端。
 */
export const COST_VISIBLE_ROLES = ['admin', 'boss', 'director', 'purchase']

export function canViewCost(roles = []) {
  const list = Array.isArray(roles) ? roles : []
  if (!list.includes('storekeeper')) return true
  return list.some((r) => COST_VISIBLE_ROLES.includes(r))
}

export const STATUS_TEXT = {
  active: '正常',
  pending: '待审核',
  disabled: '已禁用'
}

export const STATUS_TAG = {
  active: 'success',
  pending: 'warning',
  disabled: 'danger'
}
