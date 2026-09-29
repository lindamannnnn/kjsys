/**
 * ============================================================
 * 仓库解析与「仓库级数据权限」
 * ------------------------------------------------------------
 * 背景：原原型前端用字符串编码（'peijian' / 'chengpin'），
 *       数据库里是自增数字 id，接口层必须同时兼容两种写法。
 *
 * ⚠️ 整改说明（来自 4 角色使用者测试 P0-3.1）：
 *   原实现里 canAccessWarehouse() 定义了却「全项目零调用」，
 *   导致配件仓的出库员能扣成品仓库存、仓管能跨仓改账。
 *   现统一由本文件提供三种能力，各模块必须调用：
 *     1. requireWarehouseAccess()  写操作前拦截（不通过直接 403）
 *     2. visibleWarehouseIds()     读操作的数据范围（用于 SQL 过滤）
 *     3. warehouseScope()          生成 SQL 片段，减少各模块重复代码
 *
 * 权限语义：
 *   - admin / boss：所有仓库（不受 warehouse_ids 限制）
 *   - 其他角色：warehouse_ids 里配置的仓库
 *   - warehouse_ids 为空：视为「未做仓库隔离」，不限制（保持向后兼容）
 * ============================================================
 */
const { query, queryOne } = require('../db/pool')
const { errors } = require('../utils/response')

const DEFAULT_CODE = 'peijian'

/**
 * 把前端传来的仓库标识统一解析成数据库 id
 * @param {string|number} value 'peijian' / 'chengpin' / 1 / 2
 * @returns {Promise<number|null>}
 */
async function resolveWarehouseId(value) {
  if (value === null || value === undefined || value === '') return null

  const s = String(value).trim()
  if (!s) return null

  // 纯数字：直接当 id
  if (/^\d+$/.test(s)) {
    return Number(s)
  }

  // 否则按 code 查
  const row = await queryOne(
    'SELECT id FROM warehouses WHERE code = ? AND is_deleted = 0 LIMIT 1',
    [s]
  )
  return row ? row.id : null
}

/** 解析仓库，找不到则取默认配件仓 */
async function resolveWarehouseIdOrDefault(value) {
  const id = await resolveWarehouseId(value)
  if (id) return id
  return resolveWarehouseId(DEFAULT_CODE)
}

/** 查询全部仓库（供前端选择器使用） */
async function listWarehouses() {
  return query(
    'SELECT id, code, name, sort_order FROM warehouses WHERE is_deleted = 0 ORDER BY sort_order ASC, id ASC'
  )
}

/**
 * 用户可操作的仓库 id 列表
 * @returns {number[]|null} null 表示「不限制」（管理角色，或未配置仓库）
 */
function visibleWarehouseIds(user) {
  if (!user) return []
  const roles = user.roles || []
  if (roles.includes('admin') || roles.includes('boss')) return null

  const allow = (user.warehouse_ids || []).map(Number).filter(Boolean)
  // 未配置仓库 = 未做隔离，保持向后兼容（不做限制）
  if (!allow.length) return null
  return allow
}

/**
 * 判断用户是否有权操作某仓库（保留原签名，语义不变）
 */
function canAccessWarehouse(user, warehouseId) {
  if (!user) return false
  const roles = user.roles || []
  if (roles.includes('admin') || roles.includes('boss')) return true
  const allow = (user.warehouse_ids || []).map(Number).filter(Boolean)
  if (!allow.length) return true
  if (warehouseId === null || warehouseId === undefined || warehouseId === '') return false
  return allow.includes(Number(warehouseId))
}

/**
 * 写操作前强制校验仓库权限，不通过直接抛 403
 * @param {object} user ctx.user
 * @param {number|string} warehouseId 仓库 id
 * @param {string} label 业务名称，用于拼提示（如「出库单」）
 */
function requireWarehouseAccess(user, warehouseId, label = '该仓库') {
  if (!user) throw errors.unauthorized('请先登录')
  const wid = Number(warehouseId)
  if (!Number.isFinite(wid) || wid <= 0) {
    throw errors.badRequest(`无法确定${label}所属仓库，请重新选择`)
  }
  if (!canAccessWarehouse(user, wid)) {
    throw errors.forbidden(
      `你没有「${label}」所在仓库的操作权限，请联系管理员分配`
    )
  }
  return wid
}

/**
 * 生成「指定别名表」的仓库范围 SQL 片段
 * @param {object} user ctx.user
 * @param {string} alias 表别名，如 'o'
 * @param {number|string} [requested] 前端显式指定的仓库（可选）
 * @returns {{ sql: string, params: number[] }}
 *          sql 已含前导 "AND"，可直接拼到 WHERE 后面；无限制时返回空串
 */
function warehouseScope(user, alias = 'o', requested) {
  const visible = visibleWarehouseIds(user)
  const col = `${alias}.warehouse_id`

  // 显式指定了仓库
  if (requested !== null && requested !== undefined && requested !== '') {
    const wid = Number(requested)
    if (Number.isFinite(wid) && wid > 0) {
      // 指定了他无权访问的仓库 → 返回永假条件（等价于查不到数据，不泄露存在性）
      if (visible && !visible.includes(wid)) {
        return { sql: 'AND 1 = 0', params: [] }
      }
      return { sql: `AND ${col} = ?`, params: [wid] }
    }
  }

  // 未指定：按可见范围收敛
  if (visible === null) return { sql: '', params: [] }
  if (!visible.length) return { sql: 'AND 1 = 0', params: [] }
  return {
    sql: `AND ${col} IN (${visible.map(() => '?').join(',')})`,
    params: visible
  }
}

/**
 * 生成「物料表」的仓库范围 SQL 片段（字段名是 m.warehouse_id，语义同上）
 */
function materialWarehouseScope(user, alias = 'm', requested) {
  return warehouseScope(user, alias, requested)
}

module.exports = {
  resolveWarehouseId,
  resolveWarehouseIdOrDefault,
  listWarehouses,
  canAccessWarehouse,
  requireWarehouseAccess,
  visibleWarehouseIds,
  warehouseScope,
  materialWarehouseScope,
  DEFAULT_CODE
}
