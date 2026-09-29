/**
 * ============================================================
 * 入库模块
 * ------------------------------------------------------------
 * 关键保障：
 *   1. 幂等：同一 client_request_id 只生效一次
 *   2. 事务 + 行锁，入库同时维护移动加权平均成本
 *   3. 驳回/撤销时回退库存
 *
 * ⚠️ 整改说明（来自 4 角色使用者测试，报告见 docs/4-ROLE-USER-TEST-REPORT.md）：
 *   P0-3.3 改价「假失败真落库」：total 声明在事务闭包内、用在闭包外，
 *          事务提交后才抛 ReferenceError → 返回 500 但数据已改。现已修
 *   P0-3.4 改价忽略 material_id，把整单明细覆盖成同一个价 → 现按料号精确改，
 *          多明细整单改价直接拒绝（避免误伤）
 *   P0-3.5 改价后不重算加权成本 → 现按「入库金额差额」修正 avg_cost 并写流水留痕
 *   P1-1  确认前看不到物料当前库存 → detail 补 current_stock
 *   P1-3  确认无幂等 → 现条件更新 + 重复确认返回既有结果
 *   P1-11 已确认单据采购员无法纠错 → 老板/管理员可对已确认单改价（必留痕）
 *   P1-2-06 作废看不出是谁停的 → 现记录 cancel_operator
 * ============================================================
 */
const { query, queryOne, execute, withTransaction } = require('../db/pool')
const { ok, fail, errors } = require('../utils/response')
const { toApi, toDbId, num, money, qty, paging, isSameDay } = require('../utils/format')
const { positiveInt, unitPrice: validateUnitPrice } = require('../utils/validate')
const { statusText, typeText } = require('../utils/labels')
const { resolveWarehouseId } = require('../services/warehouse')
const {
  lockMaterialsSorted, addForInbound, applyChange, restoreForInboundCancel, writeLog
} = require('../services/stock')
const { nextOrderNo } = require('../services/orderNo')
const { operatorOf, hasAnyRole, identityOf } = require('../middleware/auth')

async function writeOpLog(conn, p) {
  await execute(
    `INSERT INTO operation_logs (openid, user_name, role, action, target_type, target_id, detail, result, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
    [
      p.openid || '', p.userName || '', p.role || '', p.action || '',
      p.targetType || 'order', String(p.targetId || ''), p.detail || '', p.ip || ''
    ],
    conn || null
  )
}

/** 校验并规范化入库明细（物料名称等以数据库档案为准） */
function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) {
    throw errors.badRequest('入库项不能为空')
  }
  return items.map((it) => {
    const materialId = toDbId(it.material_id)
    if (!materialId) throw errors.badRequest(`入库项缺少有效的物料 ID（${it.material_name || '未知物料'}）`)
    const name = String(it.material_name || materialId)
    // 数量必须是正整数（整改 P0-3.10）
    const quantity = positiveInt(it.quantity, `「${name}」的入库数量`)
    // 单价非负、最多两位小数
    const price = validateUnitPrice(it.unit_price, `「${name}」的入库单价`)
    return {
      material_id: materialId,
      material_name: name,
      quantity,
      unit_price: price,
      total_price: money(price * quantity)
    }
  })
}

/** 单据可见性（同出库模块口径） */
function assertOrderVisible(ctx, order) {
  if (hasAnyRole(ctx.user, ['boss', 'admin'])) return
  ctx.requireWarehouseAccess(order.warehouse_id, '该单据')
  const isOwner = order.operator_openid === identityOf(ctx.user)
  const canSeeAll = hasAnyRole(ctx.user, ['storekeeper', 'purchase'])
  if (!isOwner && !canSeeAll) {
    throw errors.forbidden('只能查看自己提交的单据')
  }
}

/**
 * 提交入库单
 * 入参：{ items:[{material_id, quantity, unit_price}], supplier, supplier_id, remark, warehouse_id }
 */
async function submit(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const items = normalizeItems(data.items)
  const supplier = String(data.supplier || '')
  const supplierId = toDbId(data.supplier_id)
  const remark = String(data.remark || '')
  const type = String(data.type || 'purchase')

  let requestedWid = null
  if (data.warehouse_id !== undefined && data.warehouse_id !== null && data.warehouse_id !== '') {
    requestedWid = await resolveWarehouseId(data.warehouse_id)
    if (!requestedWid) return fail(400, '所选仓库不存在')
    ctx.requireWarehouseAccess(requestedWid, '入库单')
  }

  const operator = operatorOf(ctx.user)

  // ---------- 幂等快速路径 ----------
  if (ctx.clientRequestId) {
    const existed = await queryOne(
      'SELECT id, order_no FROM inbound_orders WHERE client_request_id = ? LIMIT 1',
      [ctx.clientRequestId]
    )
    if (existed) {
      return ok(
        { _id: existed.id, order_no: existed.order_no, duplicated: true },
        `该入库单已提交（单号 ${existed.order_no}），请勿重复操作`
      )
    }
  }

  const totalPrice = money(items.reduce((s, it) => s + it.total_price, 0))

  const run = async (attempt) => {
    try {
      return await withTransaction(async (conn) => {
        const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))

        // 校验：同一张单只能是同一个仓库的物料
        const wids = new Set()
        for (const it of items) {
          const material = matMap.get(it.material_id)
          if (!material) throw errors.badRequest(`物料不存在或已删除（id=${it.material_id}）`)
          wids.add(Number(material.warehouse_id))
        }
        if (wids.size > 1) {
          throw errors.badRequest(
            `一张入库单不能包含多个仓库的物料（当前混了仓库 ${[...wids].join('、')}）。请分开提交`
          )
        }
        const wid = [...wids][0]
        if (requestedWid && requestedWid !== wid) {
          throw errors.badRequest('所选仓库与物料的实际所属仓库不一致，请刷新物料清单后重试')
        }
        ctx.requireWarehouseAccess(wid, '入库单')

        const orderNo = await nextOrderNo(conn, 'inbound')

        // 逐项增加库存 + 维护加权平均成本
        for (const it of items) {
          const material = matMap.get(it.material_id)
          await addForInbound(conn, {
            material,
            quantity: it.quantity,
            unitPrice: it.unit_price,
            orderNo,
            operator,
            remark: remark || `入库-${typeText('inbound', type)}`
          })
          it.material_name = material.name
          it.material_spec = material.spec || ''
          it.unit = material.unit || ''
        }

        const mainRes = await execute(
          `INSERT INTO inbound_orders
             (order_no, warehouse_id, type, supplier, supplier_id, total_price,
              operator_openid, operator_name, remark, status,
              client_request_id, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NOW(), NOW())`,
          [
            orderNo, wid, type, supplier, supplierId || null, totalPrice,
            operator.openid, operator.name, remark, ctx.clientRequestId || null
          ],
          conn
        )
        const orderId = mainRes.insertId

        for (const it of items) {
          await execute(
            `INSERT INTO inbound_order_items
               (order_id, material_id, material_name, material_spec, quantity, unit, unit_price, total_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              orderId, it.material_id, it.material_name, it.material_spec,
              it.quantity, it.unit, it.unit_price, it.total_price
            ],
            conn
          )
        }

        await writeOpLog(conn, {
          openid: operator.openid, userName: operator.name,
          role: (ctx.user.roles || []).join(','),
          action: 'inbound_submit', targetType: 'order', targetId: orderId,
          detail: `提交入库单 ${orderNo}，共 ${items.length} 项，合计 ¥${totalPrice}`, ip: ctx.ip
        })

        return { orderId, orderNo, totalPrice }
      })
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        if (ctx.clientRequestId) {
          const existed = await queryOne(
            'SELECT id, order_no FROM inbound_orders WHERE client_request_id = ? LIMIT 1',
            [ctx.clientRequestId]
          )
          if (existed) return { orderId: existed.id, orderNo: existed.order_no, duplicated: true, totalPrice }
        }
        if (attempt < 3) return run(attempt + 1)
      }
      throw err
    }
  }

  const result = await run(0)

  if (result.duplicated) {
    return ok(
      { _id: result.orderId, order_no: result.orderNo, duplicated: true },
      `该入库单已提交（单号 ${result.orderNo}），请勿重复操作`
    )
  }

  return ok(
    { _id: result.orderId, order_no: result.orderNo, total_price: result.totalPrice },
    '入库单提交成功'
  )
}

/** 入库单列表 */
async function list(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const { page, pageSize, offset } = paging(data, data.forExport ? 5000 : 200)
  const { status, startDate, endDate, keyword, supplier, warehouse_id: warehouseId, type } = data

  const where = ['o.is_deleted = 0']
  const params = []

  const canSeeAll = hasAnyRole(ctx.user, ['boss', 'admin', 'storekeeper', 'purchase'])
  if (!canSeeAll) {
    where.push('o.operator_openid = ?')
    params.push(identityOf(ctx.user))
  }

  // 仓库级数据权限
  const scope = ctx.warehouseScope('o', warehouseId)
  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }

  if (status) {
    where.push('o.status = ?')
    params.push(String(status))
  }
  if (type) {
    where.push('o.type = ?')
    params.push(String(type))
  }
  if (supplier) {
    where.push('o.supplier = ?')
    params.push(String(supplier))
  }
  if (startDate && endDate) {
    where.push('o.created_at >= ? AND o.created_at <= ?')
    params.push(new Date(`${startDate} 00:00:00`), new Date(`${endDate} 23:59:59`))
  }
  if (keyword && String(keyword).trim()) {
    where.push('(o.order_no LIKE ? OR o.supplier LIKE ?)')
    const kw = `%${String(keyword).trim()}%`
    params.push(kw, kw)
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM inbound_orders o WHERE ${whereSql}`, params)
  const orders = await query(
    `SELECT o.*, w.name AS warehouse_name
       FROM inbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
      WHERE ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  if (orders.length) {
    const ids = orders.map((o) => o.id)
    const itemRows = await query(
      `SELECT * FROM inbound_order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`,
      ids
    )
    const grouped = {}
    for (const it of itemRows) {
      if (!grouped[it.order_id]) grouped[it.order_id] = []
      grouped[it.order_id].push(it)
    }
    for (const o of orders) {
      o.items = grouped[o.id] || []
      o.status_text = statusText(o.status)
      o.type_text = typeText('inbound', o.type)
    }
  }

  return ok({ list: toApi(orders), total: cnt.total, page, pageSize })
}

/** 入库单详情（附物料当前库存，供仓管确认前判断） */
async function detail(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne(
    `SELECT o.*, w.name AS warehouse_name
       FROM inbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
      WHERE o.id = ?`,
    [id]
  )
  if (!order) return fail(404, '单据不存在')

  assertOrderVisible(ctx, order)

  const items = await query('SELECT * FROM inbound_order_items WHERE order_id = ? ORDER BY id', [id])
  for (const it of items) {
    const m = await queryOne(
      'SELECT current_stock, unit FROM materials WHERE id = ? AND is_deleted = 0',
      [it.material_id]
    )
    it.current_stock = m ? num(m.current_stock) : 0
    it.unit = it.unit || (m ? m.unit : '')
  }

  order.items = items
  order.status_text = statusText(order.status)
  order.type_text = typeText('inbound', order.type)

  return ok(toApi(order))
}

/**
 * 修改入库单价
 *
 * 入参（两种，推荐第一种）：
 *   { id, items:[{material_id, unit_price}] }   按料号精确改（多明细单据必须用这种）
 *   { id, unit_price }                          整单同价（仅允许单项单据，兼容旧调用）
 *
 * 行为（三项一次做全，缺一项账就对不平）：
 *   1. 只改指定明细，不再无差别覆盖整单
 *   2. 重算单据金额
 *   3. 按「入库金额差额」修正物料加权平均成本，并写 stock_logs 留痕
 */
async function updatePrice(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM inbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  ctx.requireWarehouseAccess(order.warehouse_id, '该入库单')

  const isManager = hasAnyRole(ctx.user, ['boss', 'admin'])
  const isOwner = order.operator_openid === identityOf(ctx.user)

  if (!isOwner && !isManager) return fail(403, '只能修改自己提交的单据')
  if (order.status === 'cancelled') return fail(400, '该单据已作废，不能修改单价')
  if (order.status === 'confirmed' && !isManager) {
    return fail(
      403,
      '该单据已被仓管确认，不能自行改价。为防止账实不符，请让老板或管理员处理（改价会自动重算库存成本并留痕）'
    )
  }
  if (order.status === 'pending' && !isSameDay(order.created_at, new Date()) && !isManager) {
    return fail(400, '只能修改当天提交的单据（隔天改价请让老板或管理员处理）')
  }

  const items = await query('SELECT * FROM inbound_order_items WHERE order_id = ?', [id])
  if (!items.length) return fail(400, '该单据没有明细，无法改价')

  // ---------- 解析要改哪些明细 ----------
  const changes = []
  const patch = Array.isArray(data.items) ? data.items : null

  if (patch && patch.length) {
    for (const p of patch) {
      const mid = toDbId(p.material_id)
      if (!mid) throw errors.badRequest('改价明细缺少物料 ID')
      const target = items.find((it) => Number(it.material_id) === mid)
      if (!target) throw errors.badRequest(`该单据中没有物料 id=${mid} 的明细，请刷新后重试`)
      changes.push({ item: target, newPrice: validateUnitPrice(p.unit_price, `「${target.material_name}」的单价`) })
    }
  } else {
    // 兼容旧调用：整单同一个价。多明细时明确拒绝（原实现正是在这里把整单覆盖掉的）
    if (items.length > 1) {
      throw errors.badRequest(
        `该单据有 ${items.length} 项明细，为避免连带改错，请指定要改哪一项：` +
        `items:[{material_id, unit_price}]`
      )
    }
    changes.push({ item: items[0], newPrice: validateUnitPrice(data.unit_price, `「${items[0].material_name}」的单价`) })
  }

  const operator = operatorOf(ctx.user)
  const isAfterConfirm = order.status === 'confirmed'

  // ---------- 事务：改明细 → 重算单据金额 → 修正加权成本 + 留痕 ----------
  const result = await withTransaction(async (conn) => {
    const locked = await lockMaterialsSorted(conn, changes.map((c) => c.item.material_id))
    const applied = []

    for (const c of changes) {
      const oldPrice = num(c.item.unit_price)
      const stockQty = num(c.item.quantity)
      if (Math.abs(oldPrice - c.newPrice) < 1e-9) {
        applied.push({
          material_id: Number(c.item.material_id),
          material_name: c.item.material_name,
          old_price: oldPrice,
          new_price: c.newPrice,
          quantity: stockQty,
          amount_delta: 0,
          cost_before: null,
          cost_after: null,
          skipped: true
        })
        continue
      }

      const sub = money(c.newPrice * stockQty)
      await execute(
        'UPDATE inbound_order_items SET unit_price = ?, total_price = ? WHERE id = ?',
        [c.newPrice, sub, c.item.id],
        conn
      )

      // 入库金额的变化量 → 库存价值随之变化，加权成本必须同步修正
      const amountDelta = money((c.newPrice - oldPrice) * stockQty)
      const material = locked.get(Number(c.item.material_id))
      let costBefore = null
      let costAfter = null

      if (material) {
        const stockNow = num(material.current_stock)
        const oldCost = num(material.avg_cost)
        costBefore = oldCost

        if (stockNow > 0) {
          let newCost = Number(((oldCost * stockNow + amountDelta) / stockNow).toFixed(4))
          if (newCost < 0) newCost = 0
          costAfter = newCost
          if (Math.abs(newCost - oldCost) > 1e-9) {
            await execute('UPDATE materials SET avg_cost = ? WHERE id = ?', [newCost, material.id], conn)
            material.avg_cost = newCost
            // 留痕：库存数量不变，但账面价值变了，必须能在流水里查到
            await writeLog(conn, {
              materialId: material.id,
              materialName: material.name,
              warehouseId: material.warehouse_id,
              changeType: 'price_adjust',
              delta: 0,
              before: stockNow,
              after: stockNow,
              orderNo: order.order_no,
              orderType: 'inbound',
              operatorOpenid: operator.openid,
              operatorName: operator.name,
              remark: `改价成本修正：单价 ${oldPrice} → ${c.newPrice}，成本价 ${oldCost} → ${newCost}`
            })
          }
        }
      }

      applied.push({
        material_id: Number(c.item.material_id),
        material_name: c.item.material_name,
        old_price: oldPrice,
        new_price: c.newPrice,
        quantity: stockQty,
        amount_delta: amountDelta,
        cost_before: costBefore,
        cost_after: costAfter
      })
    }

    // 重算整单金额（以明细为准，避免累加误差）
    const sum = await queryOne(
      'SELECT COALESCE(SUM(total_price), 0) AS s FROM inbound_order_items WHERE order_id = ?',
      [id],
      conn
    )
    const newTotal = money(sum.s)
    await execute('UPDATE inbound_orders SET total_price = ? WHERE id = ?', [newTotal, id], conn)

    return { applied, newTotal }
  })

  const changed = result.applied.filter((a) => !a.skipped)
  const detailText = changed.length
    ? changed.map((a) => `${a.material_name} ${a.old_price}→${a.new_price}`).join('；')
    : '单价未变化'

  await writeOpLog(null, {
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'inbound_update_price', targetType: 'order', targetId: id,
    detail:
      `修改入库单 ${order.order_no} 单价：${detailText}，单据金额 ${order.total_price} → ${result.newTotal}` +
      (isAfterConfirm ? '（已确认单据事后纠错）' : ''),
    ip: ctx.ip
  })

  const costChanged = changed.filter((a) => a.cost_after !== null && Math.abs(num(a.cost_after) - num(a.cost_before)) > 1e-9)

  return ok(
    {
      total_price: result.newTotal,
      changed: changed.length,
      cost_adjusted: costChanged.length,
      items: changed
    },
    changed.length
      ? `单价修改成功，单据金额已更新为 ¥${result.newTotal}` +
        (costChanged.length ? `，并重算 ${costChanged.length} 项物料的库存成本` : '')
      : '单价没有变化，无需修改'
  )
}

/** 确认入库单（仓管 / 老板 / 管理员），幂等 */
async function confirm(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM inbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  ctx.requireWarehouseAccess(order.warehouse_id, '该单据')

  if (order.status === 'confirmed') {
    return ok(
      {
        duplicated: true,
        confirmed_at: order.confirmed_at,
        confirm_operator_name: order.confirm_operator_name
      },
      `该单据已由「${order.confirm_operator_name || '他人'}」于 ${order.confirmed_at || ''} 确认，无需重复确认`
    )
  }
  if (order.status !== 'pending') {
    return fail(400, `只有待确认的单据可以确认（当前状态：${statusText(order.status)}）`)
  }

  const operator = operatorOf(ctx.user)

  const res = await execute(
    `UPDATE inbound_orders
        SET status = 'confirmed', confirm_operator_openid = ?, confirm_operator_name = ?, confirmed_at = NOW()
      WHERE id = ? AND status = 'pending'`,
    [operator.openid, operator.name, id]
  )

  if (!res.affectedRows) {
    const latest = await queryOne('SELECT * FROM inbound_orders WHERE id = ?', [id])
    return ok(
      {
        duplicated: true,
        confirmed_at: latest ? latest.confirmed_at : null,
        confirm_operator_name: latest ? latest.confirm_operator_name : ''
      },
      '该单据刚刚已被确认，无需重复操作'
    )
  }

  await writeOpLog(null, {
    openid: operator.openid, userName: operator.name,
    action: 'inbound_confirm', targetType: 'order', targetId: id,
    detail: `确认入库单 ${order.order_no}`, ip: ctx.ip
  })

  return ok(null, '确认成功')
}

/** 作废入库单（回退库存），并记录作废人与原因 */
async function cancel(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const reason = String(data.reason || data.remark || '')
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM inbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  assertOrderVisible(ctx, order)

  const isManager = hasAnyRole(ctx.user, ['boss', 'admin'])
  const isOwner = order.operator_openid === identityOf(ctx.user)

  if (order.status === 'cancelled') return fail(400, '该单据已作废')
  if (!isOwner && !isManager) return fail(403, '只能作废自己提交的单据')
  if (order.status === 'confirmed' && !isManager) {
    return fail(403, '该单据已确认，仅管理员可作废')
  }

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM inbound_order_items WHERE order_id = ?', [id])

  await withTransaction(async (conn) => {
    const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))

    for (const it of items) {
      const material = matMap.get(it.material_id)
      if (!material) continue

      // 若该物料已被领用导致库存不足，则不允许作废（否则会出现负库存）
      const after = qty(num(material.current_stock) - num(it.quantity))
      if (after < 0) {
        throw errors.biz(
          `无法作废：物料「${material.name}」入库后已被领用，当前库存 ${material.current_stock}，` +
          `作废将需要扣减 ${it.quantity}。请先处理相关出库单据`
        )
      }

      await applyChange(conn, {
        material,
        delta: -num(it.quantity),
        changeType: 'inbound_cancel',
        orderNo: order.order_no,
        orderType: 'inbound',
        operator,
        remark: '入库作废，库存回退'
      })
    }

    await execute(
      `UPDATE inbound_orders
          SET status = 'cancelled', cancelled_at = NOW(),
              cancel_operator_openid = ?, cancel_operator_name = ?, cancel_reason = ?
        WHERE id = ?`,
      [operator.openid, operator.name, reason || null, id],
      conn
    )

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      action: 'inbound_cancel', targetType: 'order', targetId: id,
      detail: `作废入库单 ${order.order_no}，库存已回退${reason ? '，原因：' + reason : ''}`, ip: ctx.ip
    })
  })

  return ok(null, '作废成功，库存已回退')
}

/** 待确认数量（按可管仓库收敛） */
async function pendingCount(ctx) {
  if (!ctx.user) return fail(401, '请先登录')
  const scope = ctx.warehouseScope('o')
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM inbound_orders o
      WHERE o.status = 'pending' AND o.is_deleted = 0 ${scope.sql}`,
    scope.params
  )
  return ok({ count: row ? row.c : 0 })
}

module.exports = {
  name: 'inbound',
  publicActions: [],
  roleRules: {
    submit: ['in', 'purchase', 'storekeeper', 'boss', 'admin'],
    confirm: ['storekeeper', 'boss', 'admin'],
    updatePrice: ['in', 'purchase', 'boss', 'admin', 'storekeeper']
  },
  actions: { submit, list, detail, updatePrice, confirm, cancel, pendingCount }
}
