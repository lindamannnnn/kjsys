/**
 * ============================================================
 * 出库模块
 * ------------------------------------------------------------
 * 关键保障：
 *   1. 幂等：同一 client_request_id 重复提交只生效一次（数据库唯一索引兜底）
 *   2. 并发安全：事务 + 行锁（按物料 id 升序加锁，防死锁）
 *   3. 全部库存变动写 stock_logs，可追溯
 *   4. 驳回时回补库存（原云开发版遗漏，会导致账实不符）
 *
 * ⚠️ 整改说明（来自 4 角色使用者测试，报告见 docs/4-ROLE-USER-TEST-REPORT.md）：
 *   P0-3.1 仓库级权限原先零调用 → 现在提交/确认/驳回/撤销/详情全部校验
 *   P0-3.2 允许混仓下单、单头只记第一项的仓库 → 现在必须同仓，不一致直接拒绝
 *   P1-2   仓管员没有驳回权 → 现在 storekeeper 可驳回
 *   P1-3   确认无幂等（并发 8 次写 8 条日志）→ 现在重复确认直接返回既有结果
 *   P1-9   单据列表跨仓可见 → 现在按可管仓库收敛
 *   P2     物料名信客户端传值 → 现在一律取数据库物料档案
 *   P2     提示语夹英文状态词 → 现在一律输出中文
 *   P1-2-05 驳回后提交人无感知 → 新增 myNotice 动作供首页提醒
 * ============================================================
 */
const { query, queryOne, execute, withTransaction } = require('../db/pool')
const { ok, fail, errors } = require('../utils/response')
const { toApi, toDbId, num, paging, qty } = require('../utils/format')
const { positiveInt } = require('../utils/validate')
const { statusText, typeText } = require('../utils/labels')
const { resolveWarehouseId } = require('../services/warehouse')
const { lockMaterialsSorted, deductForOutbound, restoreForOutboundCancel } = require('../services/stock')
const { nextOrderNo } = require('../services/orderNo')
const { operatorOf, hasAnyRole, identityOf } = require('../middleware/auth')

/** 写操作日志 */
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

/**
 * 校验并规范化出库明细
 * 注意：物料名称/规格/单位不从客户端取值，落库时以数据库物料档案为准
 */
function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) {
    throw errors.badRequest('出库项不能为空')
  }
  return items.map((it) => {
    const materialId = toDbId(it.material_id)
    if (!materialId) throw errors.badRequest(`出库项缺少有效的物料 ID（${it.material_name || '未知物料'}）`)
    const name = String(it.material_name || materialId)
    // 数量必须是正整数（整改 P0-3.10：原来 0.5 个火花塞也能提交）
    const quantity = positiveInt(it.quantity, `「${name}」的出库数量`)
    return {
      material_id: materialId,
      quantity,
      // 仅用于报错提示，落库时会被数据库档案覆盖
      material_name: name,
      client_warehouse_id: it.warehouse_id
    }
  })
}

/**
 * 单据可见性校验
 * 管理角色（老板/管理员）可见全部；仓管/员工需在自己可管仓库内，且非仓管只能看自己的单
 */
function assertOrderVisible(ctx, order) {
  if (hasAnyRole(ctx.user, ['boss', 'admin'])) return
  ctx.requireWarehouseAccess(order.warehouse_id, '该单据')
  const isOwner = order.operator_openid === identityOf(ctx.user)
  // 仓管要确认别人的单；采购要对账，也得能打开别人的出库单（与 inbound 一致）
  const canSeeAll = hasAnyRole(ctx.user, ['storekeeper', 'purchase'])
  if (!isOwner && !canSeeAll) {
    throw errors.forbidden('只能查看自己提交的单据')
  }
}

/**
 * 提交出库单
 * 入参：{ items:[{material_id, quantity}], type, remark, warehouse_id }
 */
async function submit(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const items = normalizeItems(data.items)
  const type = String(data.type || 'lingyong')
  const remark = String(data.remark || '')

  // 前端显式指定的仓库（可为空，为空时以物料档案所在仓库为准）
  let requestedWid = null
  if (data.warehouse_id !== undefined && data.warehouse_id !== null && data.warehouse_id !== '') {
    requestedWid = await resolveWarehouseId(data.warehouse_id)
    if (!requestedWid) return fail(400, '所选仓库不存在')
    // 快速失败：无权操作的仓库直接拒绝，不必等事务
    ctx.requireWarehouseAccess(requestedWid, '出库单')
  }

  const operator = operatorOf(ctx.user)

  // ---------- 幂等检查（快速路径） ----------
  if (ctx.clientRequestId) {
    const existed = await queryOne(
      'SELECT id, order_no FROM outbound_orders WHERE client_request_id = ? LIMIT 1',
      [ctx.clientRequestId]
    )
    if (existed) {
      return ok(
        { _id: existed.id, order_no: existed.order_no, duplicated: true },
        `该出库单已提交（单号 ${existed.order_no}），请勿重复操作`
      )
    }
  }

  // ---------- 事务执行（撞号自动重试） ----------
  const run = async (attempt) => {
    try {
      return await withTransaction(async (conn) => {
        // 1. 按物料 id 升序加锁
        const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))

        // 2. 校验：所有明细必须属于同一仓库，且该仓库是操作者有权操作的
        const wids = new Set()
        for (const it of items) {
          const material = matMap.get(it.material_id)
          if (!material) throw errors.badRequest(`物料不存在或已删除（id=${it.material_id}）`)
          wids.add(Number(material.warehouse_id))
        }
        if (wids.size > 1) {
          const names = [...wids].join('、')
          throw errors.badRequest(
            `一张出库单不能包含多个仓库的物料（当前混了仓库 ${names}）。请分开提交`
          )
        }
        const wid = [...wids][0]
        if (requestedWid && requestedWid !== wid) {
          throw errors.badRequest('所选仓库与物料的实际所属仓库不一致，请刷新物料清单后重试')
        }
        ctx.requireWarehouseAccess(wid, '出库单')

        // 3. 生成单号
        const orderNo = await nextOrderNo(conn, 'outbound')

        // 4. 逐项扣减库存 + 写流水（物料名/规格/单位一律取数据库档案）
        for (const it of items) {
          const material = matMap.get(it.material_id)
          await deductForOutbound(conn, {
            material,
            quantity: it.quantity,
            orderNo,
            operator,
            remark: remark || `出库-${typeText('outbound', type)}`
          })
          it.material_name = material.name
          it.material_spec = material.spec || ''
          it.unit = material.unit || ''
        }

        // 5. 主单
        const mainRes = await execute(
          `INSERT INTO outbound_orders
             (order_no, warehouse_id, type, operator_openid, operator_name, remark, status,
              client_request_id, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, NOW(), NOW())`,
          [orderNo, wid, type, operator.openid, operator.name, remark, ctx.clientRequestId || null],
          conn
        )
        const orderId = mainRes.insertId

        // 6. 明细
        for (const it of items) {
          await execute(
            `INSERT INTO outbound_order_items
               (order_id, material_id, material_name, material_spec, quantity, unit)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [orderId, it.material_id, it.material_name, it.material_spec, it.quantity, it.unit],
            conn
          )
        }

        // 7. 操作日志
        await writeOpLog(conn, {
          openid: operator.openid, userName: operator.name,
          role: (ctx.user.roles || []).join(','),
          action: 'outbound_submit', targetType: 'order', targetId: orderId,
          detail: `提交出库单 ${orderNo}（${typeText('outbound', type)}），共 ${items.length} 项`, ip: ctx.ip
        })

        return { orderId, orderNo }
      })
    } catch (err) {
      // 唯一键冲突：可能是并发撞号，也可能是同一 client_request_id 并发重复提交
      if (err && err.code === 'ER_DUP_ENTRY') {
        if (ctx.clientRequestId) {
          const existed = await queryOne(
            'SELECT id, order_no FROM outbound_orders WHERE client_request_id = ? LIMIT 1',
            [ctx.clientRequestId]
          )
          if (existed) {
            return { orderId: existed.id, orderNo: existed.order_no, duplicated: true }
          }
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
      `该出库单已提交（单号 ${result.orderNo}），请勿重复操作`
    )
  }

  return ok({ _id: result.orderId, order_no: result.orderNo }, '出库单提交成功')
}

/** 出库单列表 */
async function list(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const { page, pageSize, offset } = paging(data, data.forExport ? 5000 : 200)
  const { status, startDate, endDate, keyword, warehouse_id: warehouseId, type } = data

  const where = ['o.is_deleted = 0']
  const params = []

  // 权限：老板/管理员/仓管可见（各自仓库范围内）全部，其余仅本人
  // 采购员要和自己那边的入库对账（库存为什么掉了），必须看得见出库单——
  // 原实现只给「本人」，而采购员几乎不提交出库单，等于一单都看不到（P1-12「对账缺一半」）。
  // 与 inbound.list 的可见范围保持一致。
  const canSeeAll = hasAnyRole(ctx.user, ['boss', 'admin', 'storekeeper', 'purchase'])
  if (!canSeeAll) {
    where.push('o.operator_openid = ?')
    params.push(identityOf(ctx.user))
  }

  // 仓库级数据权限（整改 P1-9：原先跨仓可见）
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
  if (startDate && endDate) {
    where.push('o.created_at >= ? AND o.created_at <= ?')
    params.push(new Date(`${startDate} 00:00:00`), new Date(`${endDate} 23:59:59`))
  }
  if (keyword && String(keyword).trim()) {
    where.push('o.order_no LIKE ?')
    params.push(`%${String(keyword).trim()}%`)
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM outbound_orders o WHERE ${whereSql}`, params)
  const orders = await query(
    `SELECT o.*, w.name AS warehouse_name
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
      WHERE ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  // 批量取明细，聚合成 items 数组（保持前端原有结构）
  if (orders.length) {
    const ids = orders.map((o) => o.id)
    const itemRows = await query(
      `SELECT * FROM outbound_order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`,
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
      o.type_text = typeText('outbound', o.type)
    }
  }

  return ok({ list: toApi(orders), total: cnt.total, page, pageSize })
}

/**
 * 出库单详情
 * 附加：每项物料的「当前库存」，让仓管不必跑去货架数就能判断该不该批（整改 P1-1）
 */
async function detail(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne(
    `SELECT o.*, w.name AS warehouse_name
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
      WHERE o.id = ?`,
    [id]
  )
  if (!order) return fail(404, '单据不存在')

  assertOrderVisible(ctx, order)

  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ? ORDER BY id', [id])

  // 补当前库存 + 是否够发，供仓管确认前判断
  for (const it of items) {
    const m = await queryOne(
      'SELECT current_stock, unit, warehouse_id FROM materials WHERE id = ? AND is_deleted = 0',
      [it.material_id]
    )
    it.current_stock = m ? num(m.current_stock) : 0
    it.unit = it.unit || (m ? m.unit : '')
    it.stock_enough = m ? num(m.current_stock) >= num(it.quantity) : false
  }

  order.items = items
  order.status_text = statusText(order.status)
  order.type_text = typeText('outbound', order.type)

  return ok(toApi(order))
}

/** 撤销出库单 */
async function cancel(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const reason = String(data.reason || data.remark || '')
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM outbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  assertOrderVisible(ctx, order)

  const operator = operatorOf(ctx.user)
  const isManager = hasAnyRole(ctx.user, ['boss', 'admin'])
  const isOwner = order.operator_openid === identityOf(ctx.user)

  if (order.status === 'cancelled') return fail(400, '该单据已作废')
  if (order.status === 'rejected') return fail(400, '该单据已被驳回，无需作废')

  // 待确认：本人可在 10 分钟内撤销；管理员不受限
  if (order.status === 'pending') {
    if (!isOwner && !isManager) return fail(403, '只能撤销自己提交的单据')
    if (!isManager) {
      const elapsed = Date.now() - new Date(order.created_at).getTime()
      if (elapsed > 10 * 60 * 1000) {
        return fail(400, '超过 10 分钟无法自行撤销，请联系仓管或管理员处理')
      }
    }
  }

  // 已确认：仅管理员可作废
  if (order.status === 'confirmed' && !isManager) {
    return fail(403, '该单据已确认，仅管理员可作废')
  }
  if (!['pending', 'confirmed'].includes(order.status)) {
    return fail(400, `当前状态「${statusText(order.status)}」不支持作废`)
  }

  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ?', [id])

  await withTransaction(async (conn) => {
    const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))

    for (const it of items) {
      const material = matMap.get(it.material_id)
      if (!material) continue
      await restoreForOutboundCancel(conn, {
        material,
        quantity: it.quantity,
        orderNo: order.order_no,
        operator
      })
    }

    // 作废人 / 原因留痕（整改 P1-2-06：原来只改状态，看不出是谁停的）
    await execute(
      `UPDATE outbound_orders
          SET status = 'cancelled', cancelled_at = NOW(),
              cancel_operator_openid = ?, cancel_operator_name = ?, cancel_reason = ?
        WHERE id = ?`,
      [operator.openid, operator.name, reason || null, id],
      conn
    )

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      action: 'outbound_cancel', targetType: 'order', targetId: id,
      detail: `作废出库单 ${order.order_no}，库存已回补${reason ? '，原因：' + reason : ''}`, ip: ctx.ip
    })
  })

  return ok(null, '作废成功，库存已回补')
}

/**
 * 确认出库单（仓管 / 老板 / 管理员）
 * 幂等（整改 P1-3）：已确认的单再点一次 → 返回既有结果，不再重复写日志
 */
async function confirm(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM outbound_orders WHERE id = ? AND is_deleted = 0', [id])
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

  // 条件更新：并发下只有一个请求能真正改成 confirmed
  const res = await execute(
    `UPDATE outbound_orders
        SET status = 'confirmed', confirm_operator_openid = ?, confirm_operator_name = ?, confirmed_at = NOW()
      WHERE id = ? AND status = 'pending'`,
    [operator.openid, operator.name, id]
  )

  if (!res.affectedRows) {
    const latest = await queryOne('SELECT * FROM outbound_orders WHERE id = ?', [id])
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
    action: 'outbound_confirm', targetType: 'order', targetId: id,
    detail: `确认出库单 ${order.order_no}`, ip: ctx.ip
  })

  return ok(null, '确认成功')
}

/** 驳回出库单（仓管 / 老板 / 管理员）—— 驳回时回补库存 */
async function reject(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const reason = String(data.reason || '')
  if (!id) return fail(400, '单据 ID 无效')
  if (!reason.trim()) return fail(400, '请填写驳回原因，提交人需要知道为什么被退回')

  const order = await queryOne('SELECT * FROM outbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  ctx.requireWarehouseAccess(order.warehouse_id, '该单据')

  if (order.status === 'rejected') {
    return ok({ duplicated: true }, '该单据已被驳回，无需重复操作')
  }
  if (order.status !== 'pending') {
    return fail(400, `只有待确认的单据可以驳回（当前状态：${statusText(order.status)}）`)
  }

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ?', [id])

  await withTransaction(async (conn) => {
    const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))

    // 驳回 = 单据不成立 → 库存必须回补，否则账实不符
    for (const it of items) {
      const material = matMap.get(it.material_id)
      if (!material) continue
      await restoreForOutboundCancel(conn, {
        material,
        quantity: it.quantity,
        orderNo: order.order_no,
        operator
      })
    }

    await execute(
      `UPDATE outbound_orders
          SET status = 'rejected', reject_reason = ?, reject_operator_openid = ?,
              reject_operator_name = ?, rejected_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [reason, operator.openid, operator.name, id],
      conn
    )

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      action: 'outbound_reject', targetType: 'order', targetId: id,
      detail: `驳回出库单 ${order.order_no}，原因：${reason}，库存已回补`, ip: ctx.ip
    })
  })

  return ok(null, '驳回成功，库存已回补')
}

/** 待确认数量（首页红点用，按可管仓库收敛） */
async function pendingCount(ctx) {
  if (!ctx.user) return fail(401, '请先登录')
  const scope = ctx.warehouseScope('o')
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM outbound_orders o
      WHERE o.status = 'pending' AND o.is_deleted = 0 ${scope.sql}`,
    scope.params
  )
  return ok({ count: row ? row.c : 0 })
}

/**
 * 我的待处理提醒（整改 P1-2-05：被驳回后提交人完全不知道）
 * 返回最近 7 天被驳回、且由本人提交的单据，供小程序首页提醒
 */
async function myNotice(ctx) {
  if (!ctx.user) return fail(401, '请先登录')

  const me = identityOf(ctx.user)
  const rows = await query(
    `SELECT o.id, o.order_no, o.status, o.reject_reason, o.rejected_at,
            o.reject_operator_name, o.warehouse_id, w.name AS warehouse_name
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
      WHERE o.is_deleted = 0
        AND o.status = 'rejected'
        AND o.operator_openid = ?
        AND o.rejected_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY o.rejected_at DESC
      LIMIT 10`,
    [me]
  )

  const cnt = await queryOne(
    `SELECT COUNT(*) AS c FROM outbound_orders
      WHERE is_deleted = 0 AND status = 'rejected' AND operator_openid = ?
        AND rejected_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    [me]
  )

  return ok({
    rejected_count: num(cnt.c),
    rejected_list: toApi(rows)
  })
}

module.exports = {
  name: 'outbound',
  publicActions: [],
  roleRules: {
    submit: ['out', 'purchase', 'storekeeper', 'boss', 'admin'],
    confirm: ['storekeeper', 'boss', 'admin'],
    // P1-2：仓管员是实际"退回去"的人，必须给驳回权
    reject: ['storekeeper', 'boss', 'admin']
  },
  actions: { submit, list, detail, cancel, confirm, reject, pendingCount, myNotice }
}
