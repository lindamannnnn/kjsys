/**
 * ============================================================
 * 库存变更【唯一出口】
 * ------------------------------------------------------------
 * 规则：任何会改变 materials.current_stock 的操作，都必须走本模块。
 * 好处：
 *   1. 全部在事务内 + 行锁（SELECT ... FOR UPDATE），并发出库不会算错
 *   2. 每笔变动都写 stock_logs，记录「变动前 / 变动后」，账实不符可追溯
 *   3. 入库自动维护移动加权平均成本
 *
 * 调用约定：调用方用 withTransaction 开事务，把 conn 传进来。
 *          加锁务必按 material_id 升序，避免多单并发时死锁。
 * ============================================================
 */
const { queryOne, execute } = require('../db/pool')
const { errors } = require('../utils/response')
const { num, qty, money, toDbId } = require('../utils/format')

/**
 * 锁定单个物料（行锁）
 * 必须在事务内调用，锁会持续到事务提交/回滚
 */
async function lockMaterial(conn, materialId) {
  const id = toDbId(materialId)
  if (!id) throw errors.badRequest('物料 ID 无效')
  const material = await queryOne(
    'SELECT * FROM materials WHERE id = ? AND is_deleted = 0 FOR UPDATE',
    [id],
    conn
  )
  if (!material) throw errors.notFound(`物料不存在或已删除（id=${materialId}）`)
  return material
}

/**
 * 批量锁定物料：按 id 升序加锁，避免并发时死锁
 * @returns {Map<number, object>} materialId -> material
 */
async function lockMaterialsSorted(conn, materialIds) {
  const ids = [...new Set(materialIds.map(toDbId).filter(Boolean))].sort((a, b) => a - b)
  const map = new Map()
  for (const id of ids) {
    map.set(id, await lockMaterial(conn, id))
  }
  return map
}

/** 写库存流水 */
async function writeLog(conn, p) {
  await execute(
    `INSERT INTO stock_logs
       (material_id, material_name, warehouse_id, change_type, change_quantity,
        before_stock, after_stock, related_order_id, related_order_type,
        operator_openid, operator_name, remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      p.materialId,
      p.materialName || '',
      p.warehouseId || null,
      p.changeType,
      p.delta,
      p.before,
      p.after,
      p.orderNo || '',
      p.orderType || '',
      p.operatorOpenid || '',
      p.operatorName || '',
      p.remark || ''
    ],
    conn
  )
}

/**
 * 通用库存变更（正数增加、负数减少）
 * @param {object} opts
 * @param {object} opts.material   已加锁的物料行
 * @param {number} opts.delta      变动量（带符号）
 * @param {string} opts.changeType inbound / outbound / outbound_cancel / check_adjust / ...
 * @param {boolean} opts.allowNegative 是否允许变负（盘点调整允许，正常出库不允许）
 */
async function applyChange(conn, opts) {
  const {
    material,
    delta,
    changeType,
    orderNo = '',
    orderType = '',
    operator = {},
    remark = '',
    allowNegative = false
  } = opts

  const before = num(material.current_stock)
  const change = qty(delta)
  const after = qty(before + change)

  if (change === 0) {
    return { before, after, changed: false }
  }

  if (!allowNegative && after < 0) {
    // 提示语整改（来自 4 角色使用者测试 P2）：
    // 原来写 `火花塞(TEST-SPK-A)`，车间员工看不懂括号里那串英文/数字是啥，
    // 会误以为是"自己填错了"。现在把规格明确标成「规格 …」，并加上单位，
    // 让「当前库存 85」这种数字有量纲可依。
    const unit = material.unit ? ` ${material.unit}` : ''
    const spec = material.spec ? `（规格 ${material.spec}）` : ''
    throw errors.biz(
      `库存不足：${material.name}${spec} ` +
      `当前库存 ${before}${unit}，本次需减少 ${Math.abs(change)}${unit}。` +
      `请先入库补货，或联系仓管核对库存`
    )
  }

  await execute('UPDATE materials SET current_stock = ? WHERE id = ?', [after, material.id], conn)

  await writeLog(conn, {
    materialId: material.id,
    materialName: material.name,
    warehouseId: material.warehouse_id,
    changeType,
    delta: change,
    before,
    after,
    orderNo,
    orderType,
    operatorOpenid: operator.openid || '',
    operatorName: operator.name || '',
    remark
  })

  // 同步内存值：同一事务内若再次操作该物料，读到的是最新值
  material.current_stock = after

  return { before, after, changed: true }
}

/** 出库扣减（不允许负库存） */
async function deductForOutbound(conn, { material, quantity, orderNo, operator, remark }) {
  const q = qty(quantity)
  if (q <= 0) throw errors.badRequest(`出库数量必须大于 0（${material.name}）`)
  return applyChange(conn, {
    material,
    delta: -q,
    changeType: 'outbound',
    orderNo,
    orderType: 'outbound',
    operator,
    remark,
    allowNegative: false
  })
}

/** 出库撤销：库存回补 */
async function restoreForOutboundCancel(conn, { material, quantity, orderNo, operator }) {
  const q = qty(quantity)
  if (q <= 0) return { before: num(material.current_stock), after: num(material.current_stock), changed: false }
  return applyChange(conn, {
    material,
    delta: q,
    changeType: 'outbound_cancel',
    orderNo,
    orderType: 'outbound',
    operator,
    remark: '出库撤销，库存回补',
    allowNegative: true
  })
}

/** 入库增加 + 移动加权平均成本 */
async function addForInbound(conn, { material, quantity, unitPrice, orderNo, operator, remark }) {
  const q = qty(quantity)
  const price = num(unitPrice)
  if (q <= 0) throw errors.badRequest(`入库数量必须大于 0（${material.name}）`)

  const before = num(material.current_stock)
  const beforeCost = num(material.avg_cost)
  const after = qty(before + q)

  // 移动加权平均：(原库存金额 + 本次入库金额) / 总数量
  const oldAmount = beforeCost * before
  const newAmount = price * q
  const avgCost = after > 0 ? Number(((oldAmount + newAmount) / after).toFixed(4)) : 0

  await execute(
    'UPDATE materials SET current_stock = ?, avg_cost = ? WHERE id = ?',
    [after, avgCost, material.id],
    conn
  )

  await writeLog(conn, {
    materialId: material.id,
    materialName: material.name,
    warehouseId: material.warehouse_id,
    changeType: 'inbound',
    delta: q,
    before,
    after,
    orderNo,
    orderType: 'inbound',
    operatorOpenid: operator.openid || '',
    operatorName: operator.name || '',
    remark: remark || `入库单价 ${price}`
  })

  material.current_stock = after
  material.avg_cost = avgCost

  return { before, after, avgCost, changed: true }
}

/**
 * 入库撤销（作废）：数量减少 + 按批次冲回加权成本
 *
 * ⚠️ P0 修复（来自 4 角色使用者测试，3 个岗位独立复现）：
 *   原实现只调 applyChange 扣数量、**成本一分不动**，与 addForInbound 完全不对称。
 *   实测：刹车片 88 → 入库后 108.8993 → 作废后仍是 108.8993（应回到 88）；
 *        机油滤芯 9.9 → 17.7136 → 作废后仍是 17.7136。
 *   后果：作废越多、账面成本越失真，老板看到的「库存总金额」是错的，
 *        还会顺着 stats 的库存金额一路错到成本报表。
 *
 * 现行口径（与 inbound.updatePrice 的「入库金额差额修正」同源，全系统一套算法）：
 *   本批次占用库存价值 = unitPrice × quantity
 *   冲回后单价 = (原加权成本 × 原库存数量 − 本批次入库金额) ÷ 冲回后库存数量
 *
 * 参数 unitPrice 必须传「该入库明细的单价」，来源 inbound_order_items.unit_price：
 *   - 单据提交后没改过价 → 就是提交时那个价
 *   - 改过价 → 明细里已是改后的价，且 updatePrice 已同步修正过 avg_cost，
 *     此处再冲回不会重复计算
 *
 * @param {object} opts
 * @param {number} opts.unitPrice 该批次入库单价（**必传**，缺失会退化成旧行为）
 */
async function restoreForInboundCancel(conn, { material, quantity, unitPrice, orderNo, operator, remark }) {
  const q = qty(quantity)
  const price = num(unitPrice)

  const before = num(material.current_stock)
  if (q <= 0) {
    return { before, after: before, changed: false, costFloored: false }
  }

  const after = qty(before - q)
  if (after < 0) {
    const unit = material.unit ? ` ${material.unit}` : ''
    throw errors.biz(
      `库存不足，无法作废该入库：${material.name} 当前库存 ${before}${unit}，` +
      `作废需扣减 ${q}${unit}。这批料可能已被领用，请先处理相关出库单据`
    )
  }

  const beforeCost = num(material.avg_cost)
  // 库存金额（数量 × 加权成本）减去本批次入库花的钱，就是冲回后剩下的库存金额
  const remainValue = beforeCost * before - price * q

  let afterCost = 0
  let costFloored = false
  if (after > 0) {
    // 极端情况（这批入库后已被领用掉一部分）：冲回后金额可能为负，
    // 说明历史出库没有结转成本、库存金额本就虚高。此处夹到 0 不产生负资产，
    // 并在流水与操作日志里明确标注，方便事后核对。
    costFloored = remainValue < 0
    afterCost = Number(((costFloored ? 0 : remainValue) / after).toFixed(4))
  }

  await execute(
    'UPDATE materials SET current_stock = ?, avg_cost = ? WHERE id = ?',
    [after, afterCost, material.id],
    conn
  )

  await writeLog(conn, {
    materialId: material.id,
    materialName: material.name,
    warehouseId: material.warehouse_id,
    changeType: 'inbound_cancel',
    delta: -q,
    before,
    after,
    orderNo,
    orderType: 'inbound',
    operatorOpenid: operator.openid || '',
    operatorName: operator.name || '',
    remark: (remark || '入库撤销') +
      (price > 0 ? `；冲回本批入库金额 ${money(price * q)}，成本价 ${beforeCost} → ${afterCost}` : '')
  })

  // 同步内存值：同一事务内若再次操作该物料，读到的是最新值
  material.current_stock = after
  material.avg_cost = afterCost

  return { before, after, beforeCost, afterCost, costFloored, changed: true }
}

/** 盘点调整：把账面库存调成实际库存（允许出现负数差异） */
async function adjustForCheck(conn, { material, actualStock, orderNo, operator, remark }) {
  const actual = qty(actualStock)
  const before = num(material.current_stock)
  const delta = qty(actual - before)

  if (delta === 0) {
    return { before, after: before, delta: 0, changed: false }
  }

  const r = await applyChange(conn, {
    material,
    delta,
    changeType: 'check_adjust',
    orderNo,
    orderType: 'check',
    operator,
    remark: remark || `盘点差异调整（账 ${before} → 实 ${actual}）`,
    allowNegative: true
  })

  return { ...r, delta }
}

module.exports = {
  lockMaterial,
  lockMaterialsSorted,
  applyChange,
  deductForOutbound,
  restoreForOutboundCancel,
  addForInbound,
  restoreForInboundCancel,
  adjustForCheck,
  writeLog
}
