/**
 * 仓库模块
 */
const { query, queryOne, execute } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, toDbId } = require('../utils/format')

/** 仓库列表（含各仓库库存汇总，供首页/看板使用） */
async function list(ctx, data = {}) {
  const rows = await query(
    `SELECT w.id, w.code, w.name, w.sort_order,
            COUNT(m.id)                                        AS material_count,
            COALESCE(SUM(m.current_stock), 0)                  AS total_stock,
            COALESCE(SUM(m.current_stock * m.avg_cost), 0)     AS total_value,
            COALESCE(SUM(CASE WHEN m.current_stock <= m.warning_stock THEN 1 ELSE 0 END), 0) AS warning_count
       FROM warehouses w
       LEFT JOIN materials m ON m.warehouse_id = w.id AND m.is_deleted = 0
      WHERE w.is_deleted = 0
      GROUP BY w.id, w.code, w.name, w.sort_order
      ORDER BY w.sort_order ASC, w.id ASC`
  )

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
    return ok({ _id: id }, '更新成功')
  }

  if (!code || !String(code).trim()) return fail(400, '仓库编码不能为空')

  const dup = await queryOne('SELECT id FROM warehouses WHERE code = ?', [String(code).trim()])
  if (dup) return fail(409, '仓库编码已存在')

  const res = await execute(
    'INSERT INTO warehouses (code, name, sort_order, is_deleted, created_at) VALUES (?, ?, ?, 0, NOW())',
    [String(code).trim(), String(name).trim(), Number(sortOrder || 0)]
  )
  return ok({ _id: res.insertId }, '创建成功')
}

module.exports = {
  name: 'warehouse',
  publicActions: [],
  roleRules: { upsert: ['boss', 'admin'] },
  actions: { list, upsert }
}
