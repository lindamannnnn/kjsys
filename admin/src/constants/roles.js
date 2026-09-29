/**
 * 系统固定角色（与后端 user.js VALID_ROLES 保持一致）
 * 角色不支持自定义增删，只能给用户分配这 6 种
 */
export const ROLES = [
  {
    value: 'out',
    label: '出库员',
    tag: 'success',
    description: '小程序提交出库单、查看自己的出库记录'
  },
  {
    value: 'in',
    label: '入库员',
    tag: 'primary',
    description: '小程序提交入库单、修改当天入库单价'
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
