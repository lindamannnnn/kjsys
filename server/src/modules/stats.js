/**
 * ============================================================
 * 统计与看板模块
 * 所有数据实时由 SQL 聚合得出（不做预计算表，避免数据不一致）
 *
 * ⚠️ 整改说明（来自 4 角色使用者测试，报告见 docs/4-ROLE-USER-TEST-REPORT.md）：
 *   P0-3.6 「今日出库」把明细行当成单数（一单两料算 2 单，看板 25 vs 统计页 23）
 *          → 改用 COUNT(DISTINCT o.id)，并与统计页口径统一
 *   P0-3.7 「今日入库金额」因 LEFT JOIN 明细导致主单金额按明细行重复累加
 *          （¥21,059 vs 真实 ¥10,024）→ 拆表查询，主单只查主单
 *   P1-1.03「今日出库量」把已作废/已驳回的单也算了进去 → 数量口径剔除无效单
 *   P1-1.04 预警清单 1910 条淹没真需求 → 默认只提示「有过出入库记录」的物料
 *   P1-8   工作台「本仓物料」含全部仓库 → 按可管仓库收敛
 *   P1-9   单据列表/流水跨仓可见 → 全模块按可管仓库收敛
 *   P1-12  采购员查不到库存流水、看不到出库单 → 放开 purchase 的只读权限
 *   P1-3-04 出库单据没有金额，导不出给会计 → 出库按库存成本估算金额
 * ============================================================
 */
const { query, queryOne } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, num, money, paging } = require('../utils/format')
const { statusText, typeText, changeTypeText } = require('../utils/labels')
const { resolveWarehouseId, warehouseScope } = require('../services/warehouse')

/** 无效单据状态（不计入出库量） */
const INVALID_ORDER_STATUS = ['cancelled', 'rejected']

/** 总览 KPI */
async function overview(ctx, data = {}) {
  const requested = data.warehouse_id
  const mScope = warehouseScope(ctx.user, 'm', requested)
  const oScope = warehouseScope(ctx.user, 'o', requested)

  const material = await queryOne(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(m.current_stock), 0)          AS total_stock,
            COALESCE(SUM(m.current_stock * m.avg_cost), 0) AS total_value,
            COALESCE(SUM(CASE WHEN m.warning_stock > 0 AND m.current_stock <= m.warning_stock THEN 1 ELSE 0 END), 0) AS warning_count,
            COALESCE(SUM(CASE WHEN m.current_stock <= 0 THEN 1 ELSE 0 END), 0) AS zero_count
       FROM materials m WHERE m.is_deleted = 0 ${mScope.sql}`,
    mScope.params
  )

  // ---- 今日出库：单数与数量分开查（数量要排除作废/驳回） ----
  const outTodayOrders = await queryOne(
    `SELECT COUNT(DISTINCT o.id) AS orders
       FROM outbound_orders o
      WHERE o.is_deleted = 0 AND DATE(o.created_at) = CURDATE() ${oScope.sql}`,
    oScope.params
  )

  const outTodayValid = await queryOne(
    `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(oi.quantity), 0) AS qty,
            COALESCE(SUM(oi.quantity * COALESCE(m.avg_cost, 0)), 0) AS amount
       FROM outbound_orders o
       JOIN outbound_order_items oi ON oi.order_id = o.id
       LEFT JOIN materials m ON m.id = oi.material_id
      WHERE o.is_deleted = 0 AND DATE(o.created_at) = CURDATE()
        AND o.status NOT IN (${INVALID_ORDER_STATUS.map(() => '?').join(',')})
        ${oScope.sql}`,
    [...INVALID_ORDER_STATUS, ...oScope.params]
  )

  // ---- 今日入库：主单金额只查主单表（避免 JOIN 明细后被重复累加） ----
  const inTodayOrders = await queryOne(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total_price), 0) AS amount
       FROM inbound_orders o
      WHERE o.is_deleted = 0 AND DATE(o.created_at) = CURDATE() ${oScope.sql}`,
    oScope.params
  )

  const inTodayQty = await queryOne(
    `SELECT COALESCE(SUM(oi.quantity), 0) AS qty
       FROM inbound_orders o
       JOIN inbound_order_items oi ON oi.order_id = o.id
      WHERE o.is_deleted = 0 AND DATE(o.created_at) = CURDATE() ${oScope.sql}`,
    oScope.params
  )

  const outMonth = await queryOne(
    `SELECT COUNT(*) AS orders FROM outbound_orders o
      WHERE o.is_deleted = 0 AND DATE_FORMAT(o.created_at, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m') ${oScope.sql}`,
    oScope.params
  )

  const pendingOut = await queryOne(
    `SELECT COUNT(*) AS c FROM outbound_orders o WHERE o.status = 'pending' AND o.is_deleted = 0 ${oScope.sql}`,
    oScope.params
  )

  const pendingIn = await queryOne(
    `SELECT COUNT(*) AS c FROM inbound_orders o WHERE o.status = 'pending' AND o.is_deleted = 0 ${oScope.sql}`,
    oScope.params
  )

  const pendingUser = await queryOne("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'")

  const cScope = warehouseScope(ctx.user, 'c', requested)
  const pendingCheck = await queryOne(
    `SELECT COUNT(*) AS c FROM stock_checks c
      WHERE c.status IN ('pending','in_progress','pending_review') ${cScope.sql}`,
    cScope.params
  )

  return ok({
    material_count: num(material.total),
    total_stock: num(material.total_stock),
    total_value: money(material.total_value),
    warning_count: num(material.warning_count),
    zero_count: num(material.zero_count),

    // 单数：与「数据统计」页 orderFlow.total 口径一致（含全部状态）
    today_outbound_orders: num(outTodayOrders.orders),
    // 有效单数与数量：剔除已作废/已驳回
    today_outbound_valid_orders: num(outTodayValid.orders),
    today_outbound_qty: num(outTodayValid.qty),
    // 出库金额按库存成本估算（会计对账用，非售价）
    today_outbound_amount: money(outTodayValid.amount),

    today_inbound_orders: num(inTodayOrders.orders),
    today_inbound_qty: num(inTodayQty.qty),
    today_inbound_amount: money(inTodayOrders.amount),

    month_outbound_orders: num(outMonth.orders),
    pending_outbound: num(pendingOut.c),
    pending_inbound: num(pendingIn.c),
    pending_users: num(pendingUser.c),
    pending_checks: num(pendingCheck.c)
  })
}

/** 出入库趋势（近 N 天） */
async function trend(ctx, data = {}) {
  const days = Math.min(Math.max(num(data.days, 7), 1), 90)
  const oScope = warehouseScope(ctx.user, 'o', data.warehouse_id)

  const outRows = await query(
    `SELECT DATE_FORMAT(o.created_at, '%Y-%m-%d') AS d, COUNT(*) AS orders
       FROM outbound_orders o
      WHERE o.is_deleted = 0 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${oScope.sql}
      GROUP BY d ORDER BY d`,
    [days, ...oScope.params]
  )

  const outQtyRows = await query(
    `SELECT DATE_FORMAT(o.created_at, '%Y-%m-%d') AS d, COALESCE(SUM(oi.quantity), 0) AS qty
       FROM outbound_orders o
       JOIN outbound_order_items oi ON oi.order_id = o.id
      WHERE o.is_deleted = 0 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND o.status NOT IN (${INVALID_ORDER_STATUS.map(() => '?').join(',')})
        ${oScope.sql}
      GROUP BY d ORDER BY d`,
    [days, ...INVALID_ORDER_STATUS, ...oScope.params]
  )

  const inRows = await query(
    `SELECT DATE_FORMAT(o.created_at, '%Y-%m-%d') AS d, COUNT(*) AS orders,
            COALESCE(SUM(o.total_price), 0) AS amount
       FROM inbound_orders o
      WHERE o.is_deleted = 0 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${oScope.sql}
      GROUP BY d ORDER BY d`,
    [days, ...oScope.params]
  )

  // 补齐没有数据的日期，避免前端折线图断裂
  const map = {}
  const today = new Date()
  for (let i = days; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    map[key] = { date: key, outbound_orders: 0, outbound_qty: 0, inbound_orders: 0, inbound_amount: 0 }
  }

  for (const r of outRows) if (map[r.d]) map[r.d].outbound_orders = num(r.orders)
  for (const r of outQtyRows) if (map[r.d]) map[r.d].outbound_qty = num(r.qty)
  for (const r of inRows) {
    if (map[r.d]) {
      map[r.d].inbound_orders = num(r.orders)
      map[r.d].inbound_amount = money(r.amount)
    }
  }

  return ok({ list: Object.values(map), days })
}

/** 库存台账 */
async function stockList(ctx, data = {}) {
  const { page, pageSize, offset } = paging(data, data.forExport ? 5000 : 200)
  const { keyword = '', category, showWarningOnly, showZeroOnly } = data
  const scope = warehouseScope(ctx.user, 'm', data.warehouse_id)

  const where = ['m.is_deleted = 0']
  const params = []

  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }
  if (category) {
    where.push('m.category = ?')
    params.push(category)
  }
  if (showWarningOnly) where.push('m.warning_stock > 0 AND m.current_stock <= m.warning_stock')
  if (showZeroOnly) where.push('m.current_stock <= 0')
  if (keyword && String(keyword).trim()) {
    const kw = `%${String(keyword).trim()}%`
    where.push('(m.name LIKE ? OR m.spec LIKE ?)')
    params.push(kw, kw)
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM materials m WHERE ${whereSql}`, params)
  const rows = await query(
    `SELECT m.*, w.name AS warehouse_name,
            (m.current_stock * m.avg_cost) AS stock_value
       FROM materials m LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE ${whereSql}
      ORDER BY stock_value DESC, m.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  const totalValue = await queryOne(
    `SELECT COALESCE(SUM(m.current_stock * m.avg_cost), 0) AS v FROM materials m WHERE ${whereSql}`,
    params
  )

  return ok({
    list: toApi(rows),
    total: cnt.total,
    page,
    pageSize,
    total_value: money(totalValue.v)
  })
}

/** 单据流水（出库 + 入库合并） */
async function orderFlow(ctx, data = {}) {
  const { page, pageSize, offset } = paging(data, data.forExport ? 5000 : 200)
  const { type, status, startDate, endDate, operator } = data

  const conds = []
  const params = []

  if (type === 'outbound' || type === 'inbound') {
    conds.push('kind = ?')
    params.push(type)
  }
  if (status) {
    conds.push('status = ?')
    params.push(String(status))
  }
  if (operator && String(operator).trim()) {
    conds.push('operator_name LIKE ?')
    params.push(`%${String(operator).trim()}%`)
  }
  if (startDate && endDate) {
    conds.push('created_at >= ? AND created_at <= ?')
    params.push(new Date(`${startDate} 00:00:00`), new Date(`${endDate} 23:59:59`))
  }

  // 仓库级数据权限（UNION 后的别名是 t）
  const scope = warehouseScope(ctx.user, 't', data.warehouse_id)
  if (scope.sql) {
    conds.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }

  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  // 出库金额：按库存成本估算（出库明细本身不带价，用物料当前成本价折算）
  const unionSql = `
    SELECT 'outbound' AS kind, o.id, o.order_no, o.status, o.warehouse_id, o.operator_name,
           o.created_at, o.remark,
           (SELECT COALESCE(SUM(quantity), 0) FROM outbound_order_items WHERE order_id = o.id) AS total_qty,
           (SELECT COALESCE(SUM(oi.quantity * COALESCE(m.avg_cost, 0)), 0)
              FROM outbound_order_items oi
              LEFT JOIN materials m ON m.id = oi.material_id
             WHERE oi.order_id = o.id) AS total_amount,
           (SELECT GROUP_CONCAT(material_name SEPARATOR '、') FROM outbound_order_items WHERE order_id = o.id) AS material_names,
           w.name AS warehouse_name
      FROM outbound_orders o LEFT JOIN warehouses w ON w.id = o.warehouse_id
     WHERE o.is_deleted = 0
    UNION ALL
    SELECT 'inbound' AS kind, o.id, o.order_no, o.status, o.warehouse_id, o.operator_name,
           o.created_at, o.remark,
           (SELECT COALESCE(SUM(quantity), 0) FROM inbound_order_items WHERE order_id = o.id) AS total_qty,
           o.total_price AS total_amount,
           (SELECT GROUP_CONCAT(material_name SEPARATOR '、') FROM inbound_order_items WHERE order_id = o.id) AS material_names,
           w.name AS warehouse_name
      FROM inbound_orders o LEFT JOIN warehouses w ON w.id = o.warehouse_id
     WHERE o.is_deleted = 0
  `

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM (${unionSql}) t ${whereSql}`, params)
  const rows = await query(
    `SELECT * FROM (${unionSql}) t ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  for (const r of rows) {
    r.status_text = statusText(r.status)
    r.type_text = typeText(r.kind, r.kind === 'inbound' ? 'purchase' : 'lingyong')
  }

  return ok({ list: toApi(rows), total: cnt.total, page, pageSize })
}

/**
 * 库存预警列表
 * 默认只提示「有过出入库记录」的物料（整改 P1-1.04）：
 * 1909 条从未流转过的档案料全部列出来，会把真正的缺货淹没。
 * 需要看全量时传 includeIdle = true
 */
async function warning(ctx, data = {}) {
  const { page, pageSize, offset } = paging(data, data.forExport ? 5000 : 200)
  const scope = warehouseScope(ctx.user, 'm', data.warehouse_id)

  const where = ['m.is_deleted = 0', 'm.warning_stock > 0', 'm.current_stock < m.warning_stock']
  const params = []

  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }
  if (!data.includeIdle) {
    where.push('EXISTS (SELECT 1 FROM stock_logs l WHERE l.material_id = m.id)')
  }
  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM materials m WHERE ${whereSql}`, params)
  const rows = await query(
    `SELECT m.*, w.name AS warehouse_name, (m.warning_stock - m.current_stock) AS shortage,
            CASE
              WHEN m.current_stock <= 0 THEN 'out_of_stock'
              WHEN m.current_stock <= m.warning_stock / 2 THEN 'critical'
              ELSE 'low'
            END AS severity
       FROM materials m LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE ${whereSql}
      ORDER BY (m.current_stock <= 0) DESC, shortage DESC, m.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  const outOfStock = rows.filter((r) => num(r.current_stock) <= 0).length

  return ok({
    list: toApi(rows),
    total: cnt.total,
    page,
    pageSize,
    out_of_stock: outOfStock,
    hint: data.includeIdle
      ? '当前为全量预警（含从未出入库的档案物料）'
      : '已隐藏从未发生过出入库的档案物料；如需查看全部请传 includeIdle=true'
  })
}

/** 库存流水 */
async function stockFlow(ctx, data = {}) {
  const { page, pageSize, offset } = paging(data, data.forExport ? 5000 : 200)
  const { material_id: materialId, change_type: changeType, startDate, endDate } = data

  const where = ['1 = 1']
  const params = []

  if (materialId) {
    where.push('l.material_id = ?')
    params.push(Number(materialId))
  }
  if (changeType) {
    where.push('l.change_type = ?')
    params.push(String(changeType))
  }
  if (startDate && endDate) {
    where.push('l.created_at >= ? AND l.created_at <= ?')
    params.push(new Date(`${startDate} 00:00:00`), new Date(`${endDate} 23:59:59`))
  }

  const scope = warehouseScope(ctx.user, 'l', data.warehouse_id)
  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM stock_logs l WHERE ${whereSql}`, params)
  const rows = await query(
    // related_order_id 存的就是单据号（OUT-20260929-001 / IN-...），
    // 这里补一个 order_no 别名的原因：全站（出入库单、采购单、驳回提醒）对外
    // 统一用 order_no 这个字段名给前端取，流水表用的是 related_order_id，
    // 不补别名前端对账页的「单号」列会一直是空的。
    `SELECT l.*, l.related_order_id AS order_no, w.name AS warehouse_name
       FROM stock_logs l LEFT JOIN warehouses w ON w.id = l.warehouse_id
      WHERE ${whereSql}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  // 顺带给「从流水还原当前库存」提供依据（仓管签字前要能自己加一遍）
  const sum = await queryOne(
    `SELECT COALESCE(SUM(l.change_quantity), 0) AS net FROM stock_logs l WHERE ${whereSql}`,
    params
  )

  for (const r of rows) r.change_type_text = changeTypeText(r.change_type)

  return ok({
    list: toApi(rows),
    total: cnt.total,
    page,
    pageSize,
    net_quantity: num(sum.net)
  })
}

/** 物料出入库排行 */
async function materialRank(ctx, data = {}) {
  const days = Math.min(Math.max(num(data.days, 30), 1), 365)
  const limit = Math.min(num(data.limit, 20), 100)
  const oScope = warehouseScope(ctx.user, 'o', data.warehouse_id)

  const outRows = await query(
    `SELECT oi.material_id, oi.material_name, SUM(oi.quantity) AS qty, COUNT(DISTINCT oi.order_id) AS orders
       FROM outbound_order_items oi
       JOIN outbound_orders o ON o.id = oi.order_id
      WHERE o.is_deleted = 0 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND o.status NOT IN (${INVALID_ORDER_STATUS.map(() => '?').join(',')})
        ${oScope.sql}
      GROUP BY oi.material_id, oi.material_name
      ORDER BY qty DESC LIMIT ?`,
    [days, ...INVALID_ORDER_STATUS, ...oScope.params, limit]
  )

  const inRows = await query(
    `SELECT oi.material_id, oi.material_name, SUM(oi.quantity) AS qty, SUM(oi.total_price) AS amount
       FROM inbound_order_items oi
       JOIN inbound_orders o ON o.id = oi.order_id
      WHERE o.is_deleted = 0 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ${oScope.sql}
      GROUP BY oi.material_id, oi.material_name
      ORDER BY qty DESC LIMIT ?`,
    [days, ...oScope.params, limit]
  )

  return ok({
    days,
    outbound: toApi(outRows),
    inbound: toApi(inRows)
  })
}

/** 操作员统计 */
async function operatorStats(ctx, data = {}) {
  const days = Math.min(Math.max(num(data.days, 30), 1), 365)
  const oScope = warehouseScope(ctx.user, 'o', data.warehouse_id)

  const outRows = await query(
    `SELECT o.operator_name, COUNT(*) AS orders,
            SUM((SELECT COALESCE(SUM(quantity),0) FROM outbound_order_items WHERE order_id = o.id)) AS qty
       FROM outbound_orders o
      WHERE o.is_deleted = 0 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${oScope.sql}
      GROUP BY o.operator_name ORDER BY orders DESC`,
    [days, ...oScope.params]
  )

  const inRows = await query(
    `SELECT o.operator_name, COUNT(*) AS orders, COALESCE(SUM(o.total_price), 0) AS amount
       FROM inbound_orders o
      WHERE o.is_deleted = 0 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${oScope.sql}
      GROUP BY o.operator_name ORDER BY orders DESC`,
    [days, ...oScope.params]
  )

  const cScope = warehouseScope(ctx.user, 'c', data.warehouse_id)
  const checkRows = await query(
    `SELECT c.operator_name, COUNT(*) AS tasks
       FROM stock_checks c
      WHERE c.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${cScope.sql}
      GROUP BY c.operator_name ORDER BY tasks DESC`,
    [days, ...cScope.params]
  )

  // 后台操作日志活跃度
  const loginRows = await query(
    `SELECT user_name, COUNT(*) AS times, MAX(created_at) AS last_at
       FROM operation_logs
      WHERE action = 'login' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY user_name ORDER BY times DESC LIMIT 20`,
    [days]
  )

  return ok({
    days,
    outbound: toApi(outRows),
    inbound: toApi(inRows),
    checks: toApi(checkRows),
    logins: toApi(loginRows)
  })
}

/** 仓库对比汇总（只返回有权查看的仓库） */
async function warehouseSummary(ctx) {
  const visible = ctx.visibleWarehouseIds()
  const where = ['w.is_deleted = 0']
  const params = []
  if (visible !== null) {
    if (!visible.length) return ok({ list: [] })
    where.push(`w.id IN (${visible.map(() => '?').join(',')})`)
    params.push(...visible)
  }

  const rows = await query(
    `SELECT w.id, w.code, w.name,
            COUNT(m.id) AS material_count,
            COALESCE(SUM(m.current_stock), 0) AS total_stock,
            COALESCE(SUM(m.current_stock * m.avg_cost), 0) AS total_value,
            COALESCE(SUM(CASE WHEN m.warning_stock > 0 AND m.current_stock <= m.warning_stock THEN 1 ELSE 0 END), 0) AS warning_count
       FROM warehouses w
       LEFT JOIN materials m ON m.warehouse_id = w.id AND m.is_deleted = 0
      WHERE ${where.join(' AND ')}
      GROUP BY w.id, w.code, w.name
      ORDER BY w.sort_order, w.id`,
    params
  )
  return ok({ list: toApi(rows) })
}

module.exports = {
  name: 'stats',
  publicActions: [],
  roleRules: {
    overview: ['boss', 'admin', 'storekeeper'],
    trend: ['boss', 'admin'],
    stockList: ['boss', 'admin', 'storekeeper', 'in', 'out', 'purchase'],
    // 整改 P1-12：采购员月底对账要看出库单与库存流水，放开只读权限（数据范围仍受仓库限制）
    orderFlow: ['boss', 'admin', 'storekeeper', 'purchase'],
    warning: ['boss', 'admin', 'storekeeper', 'purchase'],
    stockFlow: ['boss', 'admin', 'storekeeper', 'purchase'],
    materialRank: ['boss', 'admin'],
    operatorStats: ['boss', 'admin'],
    warehouseSummary: ['boss', 'admin', 'storekeeper', 'in', 'out', 'purchase']
  },
  actions: {
    overview, trend, stockList, orderFlow, warning, stockFlow,
    materialRank, operatorStats, warehouseSummary
  }
}
