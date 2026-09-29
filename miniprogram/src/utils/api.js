/**
 * 业务接口封装（按模块聚合，页面直接调用，不再引用 mockData）
 *
 * 用法：
 *   import { outboundApi, materialApi } from '@/utils/api'
 *   const res = await outboundApi.list({ page: 1, pageSize: 20 })
 *   // res = { list, total, page, pageSize }
 */
import { callCloud } from './cloud'

export const authApi = {
  login: () => callCloud('auth', 'login'),
  register: (data) => callCloud('auth', 'register', data),
  updateProfile: (data) => callCloud('auth', 'updateProfile', data),
  getUserInfo: () => callCloud('auth', 'getUserInfo'),
  changePassword: (data) => callCloud('auth', 'changePassword', data),
  myLogs: (data) => callCloud('auth', 'myLogs', data)
}

export const materialApi = {
  list: (data) => callCloud('material', 'list', data),
  detail: (data) => callCloud('material', 'detail', data),
  upsert: (data) => callCloud('material', 'upsert', data),
  remove: (data) => callCloud('material', 'delete', data),
  categories: (data) => callCloud('material', 'categories', data)
}

export const outboundApi = {
  submit: (data) => callCloud('outbound', 'submit', data),
  list: (data) => callCloud('outbound', 'list', data),
  detail: (data) => callCloud('outbound', 'detail', data),
  cancel: (data) => callCloud('outbound', 'cancel', data),
  confirm: (data) => callCloud('outbound', 'confirm', data),
  reject: (data) => callCloud('outbound', 'reject', data),
  pendingCount: () => callCloud('outbound', 'pendingCount'),
  // 我提交的单被驳回的通知（提交人自己看得到）
  myNotice: (data) => callCloud('outbound', 'myNotice', data)
}

export const inboundApi = {
  submit: (data) => callCloud('inbound', 'submit', data),
  list: (data) => callCloud('inbound', 'list', data),
  detail: (data) => callCloud('inbound', 'detail', data),
  updatePrice: (data) => callCloud('inbound', 'updatePrice', data),
  confirm: (data) => callCloud('inbound', 'confirm', data),
  cancel: (data) => callCloud('inbound', 'cancel', data),
  pendingCount: () => callCloud('inbound', 'pendingCount')
}

export const checkApi = {
  create: (data) => callCloud('check', 'create', data),
  list: (data) => callCloud('check', 'list', data),
  detail: (data) => callCloud('check', 'detail', data),
  submit: (data) => callCloud('check', 'submit', data),
  review: (data) => callCloud('check', 'review', data),
  cancel: (data) => callCloud('check', 'cancel', data)
}

export const statsApi = {
  overview: (data) => callCloud('stats', 'overview', data),
  trend: (data) => callCloud('stats', 'trend', data),
  stockList: (data) => callCloud('stats', 'stockList', data),
  orderFlow: (data) => callCloud('stats', 'orderFlow', data),
  warning: (data) => callCloud('stats', 'warning', data),
  stockFlow: (data) => callCloud('stats', 'stockFlow', data),
  materialRank: (data) => callCloud('stats', 'materialRank', data),
  operatorStats: (data) => callCloud('stats', 'operatorStats', data),
  warehouseSummary: () => callCloud('stats', 'warehouseSummary')
}

export const supplierApi = {
  list: (data) => callCloud('supplier', 'list', data),
  detail: (data) => callCloud('supplier', 'detail', data),
  upsert: (data) => callCloud('supplier', 'upsert', data),
  remove: (data) => callCloud('supplier', 'delete', data),
  search: (data) => callCloud('supplier', 'search', data)
}

export const warehouseApi = {
  list: () => callCloud('warehouse', 'list')
}

export const userApi = {
  list: (data) => callCloud('user', 'list', data),
  detail: (data) => callCloud('user', 'detail', data),
  logs: (data) => callCloud('user', 'logs', data)
}

/* ------------------------------------------------------------
 * 通用工具
 * ------------------------------------------------------------ */

/** 统一的加载提示包装，自动处理失败提示 */
export async function withLoading(fn, { loadingText = '加载中...', showError = true } = {}) {
  uni.showLoading({ title: loadingText, mask: true })
  try {
    return await fn()
  } catch (err) {
    if (showError) {
      uni.showToast({ title: err.message || '操作失败', icon: 'none', duration: 2500 })
    }
    throw err
  } finally {
    uni.hideLoading()
  }
}

/** 单据状态文案 */
export function statusText(status) {
  const map = {
    pending: '待确认',
    confirmed: '已确认',
    cancelled: '已撤销',
    rejected: '已驳回',
    in_progress: '盘点中',
    pending_review: '待审核',
    completed: '已完成',
    approved: '已通过',
    active: '正常',
    disabled: '已禁用'
  }
  return map[status] || status || ''
}

/** 出入库类型文案 */
export function typeText(type) {
  const map = {
    lingyong: '领用',
    xiaoshou: '销售',
    baofei: '报废',
    zengpin: '赠品',
    repair: '维修',
    tiaozheng: '调整',
    caigou: '采购入库',
    purchase: '采购入库',
    tuihuo: '销售退货',
    full: '全盘',
    sample: '抽盘',
    cycle: '循环盘'
  }
  return map[type] || type || ''
}

/** 库存变动类型文案（流水页用，键名与后端 stock_logs.change_type 一致） */
export function changeTypeText(type) {
  const map = {
    inbound: '入库',
    outbound: '出库',
    outbound_cancel: '出库撤销回补',
    inbound_cancel: '入库撤销回退',
    check_adjust: '盘点差异调整',
    price_adjust: '改价成本修正',
    init: '期初建账'
  }
  return map[type] || type || ''
}

export default {
  auth: authApi,
  material: materialApi,
  outbound: outboundApi,
  inbound: inboundApi,
  check: checkApi,
  stats: statsApi,
  supplier: supplierApi,
  warehouse: warehouseApi,
  user: userApi,
  withLoading,
  statusText,
  typeText,
  changeTypeText
}
