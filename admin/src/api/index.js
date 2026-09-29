/**
 * 接口调用封装（自建服务器版）
 * 替代原微信云开发的 HTTP 触发器
 */
import axios from 'axios'

// 本地开发：http://localhost:3000
// 正式环境：https://你的域名（在 admin/.env.production 中配置 VITE_API_BASE）
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000'

const TOKEN_KEY = 'access_token'

let accessToken = localStorage.getItem(TOKEN_KEY) || ''

export function setAccessToken(token) {
  accessToken = token || ''
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export function getAccessToken() {
  return accessToken
}

export function clearAccessToken() {
  setAccessToken('')
}

/** 生成幂等键 */
function genRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/** 通用请求 */
async function request(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`
  }

  let response
  try {
    response = await axios({
      url: `${API_BASE}${url}`,
      method: options.method || 'POST',
      headers,
      data: options.data || {},
      timeout: options.timeout || 30000
    })
  } catch (networkError) {
    // 网络层错误（服务未启动 / 断网 / 超时）
    const err = new Error('无法连接服务器，请确认后端服务已启动')
    err.code = -1
    err.raw = networkError
    console.error('[网络错误]', url, networkError.message)
    throw err
  }

  return response.data
}

/**
 * 调用后端模块
 * @returns {Promise<{code:number,data:any,message:string}>} 响应体（与原结构一致）
 */
export async function callFunction(name, action, data = {}) {
  const body = await request(`/api/${name}`, {
    method: 'POST',
    data: {
      action,
      data,
      client_request_id: genRequestId()
    }
  })

  const res = body || {}

  if (res.code !== 0) {
    if (res.code === 401) {
      clearAccessToken()
      // 交给路由守卫处理跳转
      window.dispatchEvent(new CustomEvent('auth:expired'))
    }
    const err = new Error(res.message || '请求失败')
    err.code = res.code
    err.body = res
    throw err
  }

  return res
}

/* ============================================================
 * 业务接口
 * ============================================================ */

// 认证
export const authApi = {
  // 后台账号密码登录
  adminLogin: (data) => callFunction('auth', 'adminLogin', data),
  login: (data) => callFunction('auth', 'login', data),
  register: (data) => callFunction('auth', 'register', data),
  updateProfile: (data) => callFunction('auth', 'updateProfile', data),
  getUserInfo: () => callFunction('auth', 'getUserInfo'),
  changePassword: (data) => callFunction('auth', 'changePassword', data),
  myLogs: (data) => callFunction('auth', 'myLogs', data)
}

// 物料
export const materialApi = {
  list: (data) => callFunction('material', 'list', data),
  detail: (data) => callFunction('material', 'detail', data),
  upsert: (data) => callFunction('material', 'upsert', data),
  import: (data) => callFunction('material', 'import', data),
  delete: (data) => callFunction('material', 'delete', data),
  categories: (data) => callFunction('material', 'categories', data)
}

// 出库
export const outboundApi = {
  submit: (data) => callFunction('outbound', 'submit', data),
  list: (data) => callFunction('outbound', 'list', data),
  detail: (data) => callFunction('outbound', 'detail', data),
  cancel: (data) => callFunction('outbound', 'cancel', data),
  confirm: (data) => callFunction('outbound', 'confirm', data),
  reject: (data) => callFunction('outbound', 'reject', data),
  pendingCount: () => callFunction('outbound', 'pendingCount')
}

// 入库
export const inboundApi = {
  submit: (data) => callFunction('inbound', 'submit', data),
  list: (data) => callFunction('inbound', 'list', data),
  detail: (data) => callFunction('inbound', 'detail', data),
  updatePrice: (data) => callFunction('inbound', 'updatePrice', data),
  confirm: (data) => callFunction('inbound', 'confirm', data),
  cancel: (data) => callFunction('inbound', 'cancel', data),
  pendingCount: () => callFunction('inbound', 'pendingCount')
}

// 盘点
export const checkApi = {
  create: (data) => callFunction('check', 'create', data),
  list: (data) => callFunction('check', 'list', data),
  detail: (data) => callFunction('check', 'detail', data),
  submit: (data) => callFunction('check', 'submit', data),
  review: (data) => callFunction('check', 'review', data),
  cancel: (data) => callFunction('check', 'cancel', data)
}

// 统计
export const statsApi = {
  overview: (data) => callFunction('stats', 'overview', data),
  trend: (data) => callFunction('stats', 'trend', data),
  stockList: (data) => callFunction('stats', 'stockList', data),
  orderFlow: (data) => callFunction('stats', 'orderFlow', data),
  warning: (data) => callFunction('stats', 'warning', data),
  stockFlow: (data) => callFunction('stats', 'stockFlow', data),
  materialRank: (data) => callFunction('stats', 'materialRank', data),
  operatorStats: (data) => callFunction('stats', 'operatorStats', data),
  warehouseSummary: (data) => callFunction('stats', 'warehouseSummary', data)
}

// 用户管理
export const userApi = {
  list: (data) => callFunction('user', 'list', data),
  detail: (data) => callFunction('user', 'detail', data),
  approve: (data) => callFunction('user', 'approve', data),
  create: (data) => callFunction('user', 'create', data),
  update: (data) => callFunction('user', 'update', data),
  updateRole: (data) => callFunction('user', 'updateRole', data),
  disable: (data) => callFunction('user', 'disable', data),
  enable: (data) => callFunction('user', 'enable', data),
  resetPassword: (data) => callFunction('user', 'resetPassword', data),
  pendingCount: () => callFunction('user', 'pendingCount'),
  // 操作日志（审计用，支持分页/关键词/动作/时间筛选）
  logs: (data) => callFunction('user', 'logs', data)
}

// 供应商
export const supplierApi = {
  list: (data) => callFunction('supplier', 'list', data),
  detail: (data) => callFunction('supplier', 'detail', data),
  upsert: (data) => callFunction('supplier', 'upsert', data),
  delete: (data) => callFunction('supplier', 'delete', data),
  search: (data) => callFunction('supplier', 'search', data)
}

// 仓库
export const warehouseApi = {
  list: (data) => callFunction('warehouse', 'list', data),
  upsert: (data) => callFunction('warehouse', 'upsert', data)
}

/**
 * 导出 CSV（前端循环分页拉全量，再转成文件下载）
 * 说明：单次最多取 5000 条，超过会自动翻页继续拉，直到取完为止
 *
 * @param {Function} [transform] 可选。把一行展开成多行，用于「单据导出按明细拆行」这类场景。
 *                               返回数组即为该行导出的多行；返回空数组表示跳过该行。
 */
export const exportApi = {
  async csv({ module, action, params = {}, filename = 'export.csv', columns, headers, pageSize = 5000, transform }) {
    const all = []
    let page = 1

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await callFunction(module, action, {
        ...params,
        page,
        pageSize,
        forExport: true
      })

      const data = res.data || {}
      const rows = data.list || data.rows || []
      all.push(...rows)

      const total = typeof data.total === 'number' ? data.total : all.length
      // 取完了 / 本页为空 / 翻页过多（保险）→ 停止
      if (!rows.length || all.length >= total || page >= 50) break
      page++
    }

    if (!all.length) {
      throw new Error('没有可导出的数据')
    }

    // 按需展开成多行（例如一张单据含 3 项物料 → 导出 3 行）
    const out = typeof transform === 'function' ? all.flatMap((r) => transform(r) || []) : all
    if (!out.length) {
      throw new Error('没有可导出的数据')
    }

    const cols = columns || Object.keys(out[0]).filter((k) => k !== 'items' && k !== 'scope')
    // 传了 headers 就用中文表头（数组长度需与 columns 一致），否则退回英文字段名
    const header =
      Array.isArray(headers) && headers.length === cols.length ? headers.join(',') : cols.join(',')
    const body = out
      .map((r) =>
        cols
          .map((c) => {
            let v = r[c]
            if (v === null || v === undefined) v = ''
            if (typeof v === 'object') v = JSON.stringify(v)
            v = String(v).replace(/"/g, '""')
            return `"${v}"`
          })
          .join(',')
      )
      .join('\n')

    // 加 BOM，避免 Excel 打开中文乱码
    const blob = new Blob([`\uFEFF${header}\n${body}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    return { count: out.length }
  }
}

export { API_BASE }

export default {
  auth: authApi,
  material: materialApi,
  outbound: outboundApi,
  inbound: inboundApi,
  check: checkApi,
  stats: statsApi,
  user: userApi,
  supplier: supplierApi,
  warehouse: warehouseApi,
  export: exportApi
}
