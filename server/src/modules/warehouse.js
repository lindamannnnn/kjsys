/**
 * 仓库模块
 */
const { query, queryOne, execute } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, toDbId } = require('../utils/format')
const { auditFromCtx } = require('../services/audit')
const { WARNING_COND } = require('../services/warning')
const { isCostHiddenUser, maskMoneyFields } = require('../middleware/auth')

/** 仓库列表（含各仓库库存汇总，供首页/看板使用） */
async function list(ctx, data = {}) {
  // 仓库列表也要按数据权限收敛（V4 测试发现：领料员能看到全部仓库，
  // 包括不属于他的仓和测试仓，导致入库页默认选中一个空仓）
  // boss/admin 看全部（visibleWarehouseIds 返回 null 表示不限）
  const visible = ctx.visibleWarehouseIds()
  const where = ['w.is_deleted = 0']
  const params = []
  if (visible !== null) {
    if (!visible.length) return ok({ list: [] })
    where.push(`w.id IN (${visible.map(() => '?').join(',')})`)
    params.push(...visible)
  }

  const rows = await query(
    `SELECT w.id, w.code, w.name, w.sort_order,
            COUNT(m.id)                                        AS material_count,
            COALESCE(SUM(m.current_stock), 0)                  AS total_stock,
            COALESCE(SUM(m.current_stock * m.avg_cost), 0)     AS total_value,
            COALESCE(SUM(CASE WHEN ${WARNING_COND} THEN 1 ELSE 0 END), 0) AS warning_count
       FROM warehouses w
       LEFT JOIN materials m ON m.warehouse_id = w.id AND m.is_deleted = 0
      WHERE ${where.join(' AND ')}
      GROUP BY w.id, w.code, w.name, w.sort_order
      ORDER BY w.sort_order ASC, w.id ASC`,
    params
  )

  // 仓管不看金额（2026-10-10）：仓库汇总里的库存价值。
  // 这个接口前端主要拿来渲染仓库下拉框（只用 name/code/id），脱敏无副作用。
  if (isCostHiddenUser(ctx.user)) maskMoneyFields(rows, ['total_value'])

  return ok({ list: toApi(rows) })
}

/** 新增/编辑仓库 */
async function upsert(ctx, data = {}) {
  const { _id, code, name, sort_order: sortOrder } = data
  if (!name || !String(name).trim()) return fail(400, '仓库名称不能为空')

  if (_id) {
    const id = toDbId(_id)
    const exist = await queryOne('SELECT id FROM warehouses WHERE id = ? AND is_deleted = 0', [id])
    if (!exist) return fail(404, '仓库不存在')

    await execute(
      'UPDATE warehouses SET name = ?, sort_order = ? WHERE id = ?',
      [String(name).trim(), Number(sortOrder || 0), id]
    )
    // 主数据改动留痕（V3 测试 P1-9）
    await auditFromCtx(ctx, {
      action: 'warehouse_update', targetType: 'warehouse', targetId: id,
      detail: `修改仓库「${String(name).trim()}」名称/排序`
    })
    return ok({ _id: id }, '更新成功')
  }

  if (!code || !String(code).trim()) return fail(400, '仓库编码不能为空')

  const dup = await queryOne('SELECT id FROM warehouses WHERE code = ?', [String(code).trim()])
  if (dup) return fail(409, '仓库编码已存在')

  const res = await execute(
    'INSERT INTO warehouses (code, name, sort_order, is_deleted, created_at) VALUES (?, ?, ?, 0, NOW())',
    [String(code).trim(), String(name).trim(), Number(sortOrder || 0)]
  )

  // 主数据改动留痕（V3 测试 P1-9）
  await auditFromCtx(ctx, {
    action: 'warehouse_create', targetType: 'warehouse', targetId: res.insertId,
    detail: `新建仓库「${String(name).trim()}」（编码 ${String(code).trim()}）`
  })

  return ok({ _id: res.insertId }, '创建成功')
}

module.exports = {
  name: 'warehouse',
  publicActions: [],
  roleRules: { upsert: ['admin'] },
  actions: { list, upsert }
}
