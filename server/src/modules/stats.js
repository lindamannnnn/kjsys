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
const { toApi, num, money, paging, toDbId } = require('../utils/format')
const { statusText, typeText, changeTypeText } = require('../utils/labels')
const { resolveWarehouseId, warehouseScope, requireWarehouseAccess } = require('../services/warehouse')
const { WARNING_COND, WARNING_COND_INCLUDE_IDLE } = require('../services/warning')
const { isPureOutUser, maskStockFields, isCostHiddenUser, maskMoneyFields, isPartsWarehouse } = require('../middleware/auth')
const { pushMessage, MSG_TYPE } = require('../services/message')
const XLSX = require('xlsx')

/** 无效单据状态（不计入出库量） */
const INVALID_ORDER_STATUS = ['cancelled', 'rejected']

/**
 * 看板日期周期（2026-10-09 新增）
 * 背景：小程序看板顶部的「今天/本周/本月」原先只改前端变量、不传后端，
 *       数字纹丝不动 —— 用户走查时明确要求「做成真的」。
 * 口径：本周从周一开始（YEARWEEK 第二参 1），与国内习惯一致。
 */
const PERIOD_RANGE = {
  today: { label: '今天', cond: (col) => `DATE(${col}) = CURDATE()` },
  week: { label: '本周', cond: (col) => `YEARWEEK(${col}, 1) = YEARWEEK(CURDATE(), 1)` },
  month: { label: '本月', cond: (col) => `DATE_FORMAT(${col}, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m')` }
}

/** 把前端传来的 period 收敛成合法值，非法/缺省一律按「今天」 */
function normalizePeriod(p) {
  const v = String(p || 'today').toLowerCase()
  return PERIOD_RANGE[v] ? v : 'today'
}

/**
 * 预警口径：唯一出处已抽到 services/warning.js
 * （原先散落在 6 处、写法还不一致，真实造成过「看板 1906、点进去没几条」）
 */

/** 总览 KPI */
async function overview(ctx, data = {}) {
  const requested = data.warehouse_id
  const mScope = warehouseScope(ctx.user, 'm', requested)
  const oScope = warehouseScope(ctx.user, 'o', requested)
  const period = normalizePeriod(data.period)

  const material = await queryOne(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(m.current_stock), 0)          AS total_stock,
            COALESCE(SUM(m.current_stock * m.avg_cost), 0) AS total_value,
            COALESCE(SUM(CASE WHEN ${WARNING_COND} THEN 1 ELSE 0 END), 0) AS warning_count,
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

  // V2 新增的两个环节也要在后台看得到积压，否则货卡在「待拣货 / 待收货」全靠人肉翻列表
  const pickingOut = await queryOne(
    `SELECT COUNT(*) AS c FROM outbound_orders o WHERE o.status = 'picking' AND o.is_deleted = 0 ${oScope.sql}`,
    oScope.params
  )

  const receivingOut = await queryOne(
    `SELECT COUNT(*) AS c FROM outbound_orders o WHERE o.status = 'receiving' AND o.is_deleted = 0 ${oScope.sql}`,
    oScope.params
  )

  // ---- 周期口径（今天/本周/本月）：看板日期切换的真取数 ----
  // 与 today_* 口径完全一致，只是把「= CURDATE()」换成周期条件；
  // period=today 时 period_* 与 today_* 数值必然相同（回归里会卡这一条）。
  const rOutCond = PERIOD_RANGE[period].cond('o.created_at')
  const rangeOutOrders = await queryOne(
    `SELECT COUNT(DISTINCT o.id) AS orders
       FROM outbound_orders o
      WHERE o.is_deleted = 0 AND ${rOutCond} ${oScope.sql}`,
    oScope.params
  )

  const rangeOutValid = await queryOne(
    `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(oi.quantity), 0) AS qty,
            COALESCE(SUM(oi.quantity * COALESCE(m.avg_cost, 0)), 0) AS amount
       FROM outbound_orders o
       JOIN outbound_order_items oi ON oi.order_id = o.id
       LEFT JOIN materials m ON m.id = oi.material_id
      WHERE o.is_deleted = 0 AND ${rOutCond}
        AND o.status NOT IN (${INVALID_ORDER_STATUS.map(() => '?').join(',')})
        ${oScope.sql}`,
    [...INVALID_ORDER_STATUS, ...oScope.params]
  )

  const rangeInOrders = await queryOne(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total_price), 0) AS amount
       FROM inbound_orders o
      WHERE o.is_deleted = 0 AND ${rOutCond} ${oScope.sql}`,
    oScope.params
  )

  const rangeInQty = await queryOne(
    `SELECT COALESCE(SUM(oi.quantity), 0) AS qty
       FROM inbound_orders o
       JOIN inbound_order_items oi ON oi.order_id = o.id
      WHERE o.is_deleted = 0 AND ${rOutCond} ${oScope.sql}`,
    oScope.params
  )

  const pendingUser = await queryOne("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'")

  const cScope = warehouseScope(ctx.user, 'c', requested)
  const pendingCheck = await queryOne(
    `SELECT COUNT(*) AS c FROM stock_checks c
      WHERE c.status IN ('pending','in_progress','pending_review') ${cScope.sql}`,
    cScope.params
  )

  // 待补价（2026-10-20）：这批入库只有数量、还没定价，所以上面的「库存金额」
  // 只是**已定价部分**，不是全貌。必须把笔数带出去，让看板明确标「金额未定稿」，
  // 否则老板会把一个偏小的数当成真实库存价值。
  const pricePending = await queryOne(
    `SELECT COUNT(*) AS items, COUNT(DISTINCT o.id) AS orders
       FROM inbound_order_items i
       JOIN inbound_orders o ON o.id = i.order_id
      WHERE i.price_pending = 1
        AND o.is_deleted = 0
        AND o.status <> 'cancelled' ${oScope.sql}`,
    oScope.params
  )

  const payload = {
    material_count: num(material.total),
    total_stock: num(material.total_stock),
    total_value: money(material.total_value),
    // 库存金额是否完整：>0 说明有入库还没定价，上面的 total_value 只含已定价部分
    price_pending_items: num(pricePending.items),
    price_pending_orders: num(pricePending.orders),
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
    picking_outbound: num(pickingOut.c),
    receiving_outbound: num(receivingOut.c),
    pending_inbound: num(pendingIn.c),
    pending_users: num(pendingUser.c),
    pending_checks: num(pendingCheck.c),

    // ---- 周期口径（看板日期切换用；today 时与 today_* 一致）----
    period,
    period_label: PERIOD_RANGE[period].label,
    period_outbound_orders: num(rangeOutOrders.orders),
    period_outbound_valid_orders: num(rangeOutValid.orders),
    period_outbound_qty: num(rangeOutValid.qty),
    period_outbound_amount: money(rangeOutValid.amount),
    period_inbound_orders: num(rangeInOrders.orders),
    period_inbound_qty: num(rangeInQty.qty),
    period_inbound_amount: money(rangeInOrders.amount)
  }

  // 仓管不看金额（2026-10-10）：库存价值 + 四类区间金额一并抹掉
  if (isCostHiddenUser(ctx.user)) maskMoneyFields(payload)

  return ok(payload)
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
  const { keyword = '', category, sub_category: subCategory, showWarningOnly, showZeroOnly } = data
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
  if (subCategory) {
    where.push('m.sub_category = ?')
    params.push(String(subCategory).trim())
  }
  // 与看板/预警页同一套口径（原来这里写的是 `<=`，比看板多算「刚好等于阈值」的料）
  if (showWarningOnly) where.push(WARNING_COND)
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
            ROUND(m.current_stock * m.avg_cost, 2) AS stock_value
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

  if (isPureOutUser(ctx.user)) maskStockFields(rows)
  // 仓管不看金额（2026-10-10）：成本价 + 单行库存价值（汇总值在下面单独处理）
  else if (isCostHiddenUser(ctx.user)) maskMoneyFields(rows, ['avg_cost', 'stock_value'])

  const payload = {
    list: toApi(rows),
    total: cnt.total,
    page,
    pageSize,
    total_value: (isPureOutUser(ctx.user) || isCostHiddenUser(ctx.user)) ? null : money(totalValue.v)
  }
  // 仓管连「汇总库存价值」也不下发：字段直接删掉，前端据此显示「已隐藏」
  if (isCostHiddenUser(ctx.user)) delete payload.total_value

  return ok(payload)
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
           -- 出库金额按库存成本折算。必须 ROUND 到 2 位：
           -- 物料 avg_cost 是 4 位小数，直接相乘会算出 140.1666 这种金额，
           -- 与同页其它 2 位小数的金额并存，财务对账对不平（V3 测试 P1-6）
           (SELECT ROUND(COALESCE(SUM(oi.quantity * COALESCE(m.avg_cost, 0)), 0), 2)
              FROM outbound_order_items oi
              LEFT JOIN materials m ON m.id = oi.material_id
             WHERE oi.order_id = o.id) AS total_amount,
           -- 出库没有「待补价」概念（金额按库存成本折算），占位 0 保持 UNION 列数一致
           0 AS pending_count,
           (SELECT GROUP_CONCAT(material_name SEPARATOR '、') FROM outbound_order_items WHERE order_id = o.id) AS material_names,
           w.name AS warehouse_name, w.code AS warehouse_code
      FROM outbound_orders o LEFT JOIN warehouses w ON w.id = o.warehouse_id
     WHERE o.is_deleted = 0
    UNION ALL
    SELECT 'inbound' AS kind, o.id, o.order_no, o.status, o.warehouse_id, o.operator_name,
           o.created_at, o.remark,
           (SELECT COALESCE(SUM(quantity), 0) FROM inbound_order_items WHERE order_id = o.id) AS total_qty,
           o.total_price AS total_amount,
           -- 待补价项数（2026-10-20）：成品仓上线初期没有价格，总价 0 不代表「不要钱」
           o.pending_count,
           (SELECT GROUP_CONCAT(material_name SEPARATOR '、') FROM inbound_order_items WHERE order_id = o.id) AS material_names,
           w.name AS warehouse_name, w.code AS warehouse_code
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

  // 仓管不看金额（2026-10-10）：单据金额一律抹掉。
  // ⚠️ 例外：**配件仓的入库单**金额保留 —— 配件是采购来的，仓管收货要对账
  //   （用户 2026-10-10 明确要求「配件仓入库单价保留」）；
  //   成品仓（车间交成品，成本由管理核算）单据金额不下发。
  // warehouse_code 只用于这里的判定，判定完就删，不下发给任何角色（保持原契约）。
  const hideCost = isCostHiddenUser(ctx.user)
  for (const r of rows) {
    const keepInboundAmount = r.kind === 'inbound' && isPartsWarehouse(r.warehouse_code)
    if (hideCost && !keepInboundAmount) delete r.total_amount
    delete r.warehouse_code
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

  const where = ['m.is_deleted = 0']
  const params = []

  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }
  // 默认用与看板完全一致的口径（见 services/warning.js）；
  // 只有显式传 includeIdle=true 时才放开「从未出入库的档案料」
  where.push(data.includeIdle ? WARNING_COND_INCLUDE_IDLE : WARNING_COND)
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

  // ⚠️ 整改（V3 测试 P2-预警）：原实现是 `rows.filter(r => current_stock <= 0).length`，
  //   而 rows 只有**当前页**——于是 pageSize=1 时「零库存」最多显示 1，
  //   它还会随翻页变化，与看板的 zero_count 对不上。必须走全量统计。
  const outRow = await queryOne(
    `SELECT COUNT(*) AS c FROM materials m WHERE ${whereSql} AND m.current_stock <= 0`,
    params
  )
  const outOfStock = num(outRow.c)

  // 仓管不看金额（2026-10-10）：预警表 `SELECT m.*` 会把成本价一起带出来，这里抹掉
  if (isCostHiddenUser(ctx.user)) maskMoneyFields(rows, ['avg_cost'])

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

/**
 * 库存预警「通知采购」（2026-10-09 新增）
 * ------------------------------------------------------------
 * 背景：老板预警页的「通知采购」原先是个**假按钮** —— 只弹一句 toast，
 *       没有任何接口调用，老板以为通知了、实际采购根本收不到（用户走查 P1）。
 * 做法：复用站内消息底座，按角色把预警投递给 采购员 + 仓管。
 *   - 传 material_id → 只通知这一个物料
 *   - 不传 → 通知当前预警清单（最多取前 20 条，避免一次刷屏）
 * 说明：这是**沟通动作**，不改动任何业务数据（库存/单据一律不动）。
 */
async function notifyWarning(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const scope = warehouseScope(ctx.user, 'm', data.warehouse_id)
  const where = ['m.is_deleted = 0']
  const params = []
  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }
  where.push(WARNING_COND)

  const materialId = data.material_id != null && data.material_id !== '' ? toDbId(data.material_id) : null
  if (materialId) {
    where.push('m.id = ?')
    params.push(materialId)
  }
  const whereSql = where.join(' AND ')

  const rows = await query(
    `SELECT m.id, m.name, m.current_stock, m.warning_stock, m.unit, w.name AS warehouse_name
       FROM materials m LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE ${whereSql}
      ORDER BY (m.current_stock <= 0) DESC, (m.warning_stock - m.current_stock) DESC, m.id DESC
      LIMIT 20`,
    params
  )

  if (!rows.length) {
    return fail(400, materialId ? '该物料当前不在预警范围内' : '当前没有库存预警，无需通知')
  }

  const operator = ctx.user.real_name || ctx.user.nickname || '有人'
  let title
  let content
  if (materialId && rows.length === 1) {
    const r = rows[0]
    title = '库存不足，请尽快补货'
    content =
      `${operator} 提示：${r.name}${r.warehouse_name ? `（${r.warehouse_name}）` : ''} 仅剩 ` +
      `${num(r.current_stock)} ${r.unit || ''}，低于预警值 ${num(r.warning_stock)}，请尽快补货`
  } else {
    const names = rows.slice(0, 5).map((r) => r.name).join('、')
    title = '有库存预警，请尽快处理'
    content =
      `${operator} 提示：当前有 ${rows.length} 个物料库存不足（${names}` +
      `${rows.length > 5 ? ' 等' : ''}），请尽快采购补货`
  }

  // 采购员负责买、仓管负责收 —— 两边都通知到，避免「通知了但没人认领」
  const sent = await pushMessage({
    toRoles: ['purchase', 'storekeeper'],
    type: MSG_TYPE.WARNING_NOTIFY,
    title,
    content,
    refType: 'warning',
    refId: rows[0] ? rows[0].id : null
  })

  if (!sent) {
    // 有预警但没有可投递的收件人（没建采购员/仓管账号，或都没绑 openid）
    return fail(400, '没有可通知的采购员/仓管账号，请先在后台添加人员')
  }

  return ok({ notified: sent, materials: rows.length }, `已通知 ${sent} 人`)
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

  // 领料员看不到库存 → 流水里的事前/事后结余也抹掉（不然照样能反推库存）
  if (isPureOutUser(ctx.user)) {
    for (const r of rows) { delete r.before_stock; delete r.after_stock }
  }

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
            ROUND(COALESCE(SUM(m.current_stock * m.avg_cost), 0), 2) AS total_value,
            COALESCE(SUM(CASE WHEN ${WARNING_COND} THEN 1 ELSE 0 END), 0) AS warning_count
       FROM warehouses w
       LEFT JOIN materials m ON m.warehouse_id = w.id AND m.is_deleted = 0
      WHERE ${where.join(' AND ')}
      GROUP BY w.id, w.code, w.name
      ORDER BY w.sort_order, w.id`,
    params
  )

  // 仓管不看金额（2026-10-10）：仓库汇总里的库存价值
  if (isCostHiddenUser(ctx.user)) maskMoneyFields(rows, ['total_value'])

  return ok({ list: toApi(rows) })
}

/* ============================================================
 * 月结表（2026-10-13 新增）
 * 参考用户线下 Excel《成品仓库月报表》：期初结存 / 本月收入 / 本月发出 / 期末结存。
 *
 * 数量口径（以库存流水 stock_logs 为准 —— 它是库存变动的唯一事实）：
 *   期末结存 = 当前库存 - Σ(该月之后发生的所有变动)
 *   期初结存 = 期末结存 - Σ(该月净变动)
 *   本月收入 = Σ(该月正向变动)（入库、出库驳回回补、盘盈、调增…都算收入）
 *   本月发出 = |Σ(该月负向变动)|（出库、盘亏、调减…都算发出）
 *   → 期初 + 收入 - 发出 ≡ 期末，恒成立。
 *
 * 金额口径（系统没有逐时点的成本快照，只能近似，页面上已标注）：
 *   本月收入金额 = Σ(本月已确认入库单的明细金额)      ← 精确（入库单上有真实单价）
 *   期末结存金额 = 期末数量 × 当前移动平均成本 avg_cost   ← 近似
 *   本月发出金额 = 发出数量 × 当前 avg_cost              ← 近似
 *   期初结存金额 = 期末金额 - 收入金额 + 发出金额        ← 倒挤，保证账平
 *
 * 角色：boss/admin/director/storekeeper；纯仓管金额整列脱敏（与库存台账同口径）。
 * ============================================================
 */

/** 解析 'YYYY-MM'，非法则回退当月 */
function parseMonth(s) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(s || '').trim())
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12) return { y, mo }
  }
  const d = new Date()
  return { y: d.getFullYear(), mo: d.getMonth() + 1 }
}

/** 月结表数据组装（monthly 与 monthlyExport 共用）。返回 { error } 或完整数据 */
async function buildMonthly(ctx, data = {}) {
  const wid = await resolveWarehouseId(data.warehouse_id)
  if (!wid) return { error: fail(400, '请选择仓库') }
  requireWarehouseAccess(ctx.user, wid, '月结表')

  const { y, mo } = parseMonth(data.month)
  const pad = (n) => String(n).padStart(2, '0')
  const monthStart = `${y}-${pad(mo)}-01 00:00:00`
  const nextY = mo === 12 ? y + 1 : y
  const nextMo = mo === 12 ? 1 : mo + 1
  const nextStart = `${nextY}-${pad(nextMo)}-01 00:00:00`
  const monthStr = `${y}-${pad(mo)}`

  const [wh, materials, inMonth, afterMonth, inAmounts, setting] = await Promise.all([
    queryOne('SELECT id, code, name FROM warehouses WHERE id = ?', [wid]),
    query(
      `SELECT id, material_no, name, spec, unit, sub_category, current_stock, avg_cost
         FROM materials WHERE is_deleted = 0 AND warehouse_id = ? ORDER BY sub_category, material_no, id`,
      [wid]
    ),
    query(
      `SELECT material_id,
              SUM(CASE WHEN change_quantity > 0 THEN change_quantity ELSE 0 END) AS in_qty,
              SUM(CASE WHEN change_quantity < 0 THEN -change_quantity ELSE 0 END) AS out_qty,
              SUM(change_quantity) AS net
         FROM stock_logs
        WHERE warehouse_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY material_id`,
      [wid, monthStart, nextStart]
    ),
    query(
      `SELECT material_id, SUM(change_quantity) AS net_after
         FROM stock_logs
        WHERE warehouse_id = ? AND created_at >= ?
        GROUP BY material_id`,
      [wid, nextStart]
    ),
    query(
      `SELECT i.material_id, SUM(i.total_price) AS in_amount
         FROM inbound_order_items i
         JOIN inbound_orders o ON o.id = i.order_id
        WHERE o.warehouse_id = ? AND o.is_deleted = 0 AND o.status = 'confirmed'
          AND o.created_at >= ? AND o.created_at < ?
        GROUP BY i.material_id`,
      [wid, monthStart, nextStart]
    ),
    queryOne('SELECT company_name FROM settings WHERE id = 1')
  ])

  const inMonthMap = Object.fromEntries(inMonth.map((r) => [Number(r.material_id), r]))
  const afterMap = Object.fromEntries(afterMonth.map((r) => [Number(r.material_id), Number(r.net_after) || 0]))
  const inAmtMap = Object.fromEntries(inAmounts.map((r) => [Number(r.material_id), Number(r.in_amount) || 0]))

  const list = materials.map((m) => {
    const cur = num(m.current_stock)
    const cost = num(m.avg_cost)
    const agg = inMonthMap[m.id] || {}
    const inQty = num(agg.in_qty)
    const outQty = num(agg.out_qty)
    const net = num(agg.net)
    const endQty = cur - (afterMap[m.id] || 0)
    const beginQty = endQty - net
    const inAmount = inAmtMap[m.id] || 0
    const inPrice = inQty > 0 ? inAmount / inQty : 0
    const endAmount = endQty * cost
    const outAmount = outQty * cost
    const beginAmount = endAmount - inAmount + outAmount
    return {
      material_id: m.id,
      material_no: m.material_no || '',
      name: m.name,
      spec: m.spec || '',
      unit: m.unit || '',
      sub_category: m.sub_category || '',
      begin_qty: beginQty, begin_amount: Math.round(beginAmount * 100) / 100,
      in_qty: inQty, in_price: Math.round(inPrice * 100) / 100, in_amount: Math.round(inAmount * 100) / 100,
      out_qty: outQty, out_amount: Math.round(outAmount * 100) / 100,
      end_qty: endQty, end_amount: Math.round(endAmount * 100) / 100
    }
  })

  const sum = (k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0)
  const summary = {
    begin_qty: sum('begin_qty'), begin_amount: Math.round(sum('begin_amount') * 100) / 100,
    in_qty: sum('in_qty'), in_amount: Math.round(sum('in_amount') * 100) / 100,
    out_qty: sum('out_qty'), out_amount: Math.round(sum('out_amount') * 100) / 100,
    end_qty: sum('end_qty'), end_amount: Math.round(sum('end_amount') * 100) / 100
  }

  return {
    month: monthStr,
    warehouse_id: wid,
    warehouse_name: (wh && wh.name) || '',
    company_name: (setting && setting.company_name) || '胜龙',
    list,
    summary
  }
}

/** 金额脱敏列（月结表） */
const MONTHLY_MONEY_FIELDS = ['begin_amount', 'in_price', 'in_amount', 'out_amount', 'end_amount']

/** 月结表查询 */
async function monthly(ctx, data = {}) {
  const r = await buildMonthly(ctx, data)
  if (r.error) return r.error
  if (isCostHiddenUser(ctx.user)) {
    maskMoneyFields(r.list, MONTHLY_MONEY_FIELDS)
    maskMoneyFields([r.summary], MONTHLY_MONEY_FIELDS)
  }
  return ok(r)
}

/** 月结表导出 xlsx（base64 返回，前端解码下载） */
async function monthlyExport(ctx, data = {}) {
  const r = await buildMonthly(ctx, data)
  if (r.error) return r.error
  const hideMoney = isCostHiddenUser(ctx.user)
  if (hideMoney) {
    maskMoneyFields(r.list, MONTHLY_MONEY_FIELDS)
    maskMoneyFields([r.summary], MONTHLY_MONEY_FIELDS)
  }

  const moneyOrDash = (v) => (hideMoney ? '-' : (v === null || v === undefined ? '' : v))
  const header = [
    '产品编号', '产品名称', '产品规格', '单位', '车间/编号分类',
    '期初结存数量', '期初结存金额',
    '本月收入数量', '本月收入单价', '本月收入金额',
    '本月发出数量', '本月发出金额',
    '期末结存数量', '期末结存金额'
  ]
  const aoa = [
    [`${r.company_name}${r.month.replace('-', '年')}月份${r.warehouse_name}月报表`],
    [],
    header
  ]
  for (const it of r.list) {
    aoa.push([
      it.material_no, it.name, it.spec, it.unit, it.sub_category,
      it.begin_qty, moneyOrDash(it.begin_amount),
      it.in_qty, moneyOrDash(it.in_price), moneyOrDash(it.in_amount),
      it.out_qty, moneyOrDash(it.out_amount),
      it.end_qty, moneyOrDash(it.end_amount)
    ])
  }
  const s = r.summary
  aoa.push([
    '合计', '', '', '', '',
    s.begin_qty, moneyOrDash(s.begin_amount),
    s.in_qty, '', moneyOrDash(s.in_amount),
    s.out_qty, moneyOrDash(s.out_amount),
    s.end_qty, moneyOrDash(s.end_amount)
  ])

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }]
  ws['!cols'] = [{ wch: 12 }, { wch: 30 }, { wch: 20 }, { wch: 6 }, { wch: 14 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '月报表')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  const filename = `${r.company_name}${r.month.replace('-', '')}${r.warehouse_name}月报表.xlsx`
  return ok({ filename, content_base64: buf.toString('base64') })
}

module.exports = {
  name: 'stats',
  publicActions: [],
  roleRules: {
    // ⚠️ 2026-10-09 两次调整，别再改回头：
    //   第一次：老板的**审核/写入**类权限全部收回（审核盘点、驳回作废、入库、采购、物料维护…），
    //          老板只剩只读。当时连「库存台账/单据流水/库存预警」的**查看**权也一起收了。
    //   第二次（用户看到厂长看板后反馈「这个页面老板也应该能看到」）：
    //          看数类的**只读**权限还给老板 —— 库存台账/单据流水/库存预警 对老板重新放行。
    //   结论：老板 = 只读（看板 + 流水 + 台账 + 单据 + 预警 + 排行/绩效/审计日志），
    //         但**没有任何写/审动作**（写权限在 check/inbound/outbound/purchase/material/user 各模块里收）。
    //   唯 trend(趋势分析) 仍只给 admin（小程序端也不给入口，免得点了报 403）。
    overview: ['boss', 'admin', 'storekeeper', 'director'],
    trend: ['admin'],
    stockList: ['boss', 'admin', 'storekeeper', 'out', 'purchase', 'director'],
    // 整改 P1-12：采购员月底对账要看出库单与库存流水，放开只读权限（数据范围仍受仓库限制）
    orderFlow: ['boss', 'admin', 'storekeeper', 'purchase', 'director'],
    warning: ['boss', 'admin', 'storekeeper', 'purchase', 'director'],
    stockFlow: ['boss', 'admin', 'storekeeper', 'purchase', 'director'],
    materialRank: ['boss', 'admin'],
    operatorStats: ['boss', 'admin'],
    // ⚠️ 这个接口返回的是「仓库总值（含金额）」，绝不能给领料员看：
    //   库存明细（stockList）对纯领料员做了脱敏（maskStockFields），这里若放行
    //   就等于绕过脱敏拿到金额（2026-10-06 收尾厂长角色时发现并收紧）。
    //   调用方只有 老板看板 / 盘点页仓库选择 / 后台统计，均非领料员页面。
    warehouseSummary: ['boss', 'admin', 'storekeeper', 'purchase', 'director'],

    // 「通知采购」= 站内消息投递（2026-10-09 新增，替换原先的假按钮）
    // ⚠️ 这是**沟通动作**，不写任何业务数据（不动库存/单据），所以给老板也放行 ——
    //   老板的「只读」约束针对的是业务写/审动作，而不是「提醒采购补货」这种沟通。
    //   入口只在预警页（老板/仓管/厂长/采购都能看到预警），领料员看不到预警页也不给。
    notifyWarning: ['boss', 'admin', 'storekeeper', 'director'],

    // 月结表（2026-10-13 新增）：只读统计 + 导出。仓管可看数量、金额自动脱敏。
    monthly: ['boss', 'admin', 'storekeeper', 'director'],
    monthlyExport: ['boss', 'admin', 'storekeeper', 'director']
  },
  actions: {
    overview, trend, stockList, orderFlow, warning, stockFlow,
    materialRank, operatorStats, warehouseSummary, notifyWarning,
    monthly, monthlyExport
  }
}
