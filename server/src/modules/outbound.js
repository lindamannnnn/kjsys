/**
 * ============================================================
 * 出库模块（领料线）
 * ------------------------------------------------------------
 * 流程重构 V2（2026-10-03）：领料线由 2 态改为 4 态
 *   待确认 pending ──仓管确认──→ 待拣货 picking
 *        ──仓管拣货完成──→ 待收货 receiving
 *        ──领料员到场确认收货──→ 已完成 completed（**此刻才扣减库存**）
 *   每一次推进都给对方发站内消息，领料员不必刷页面等结果。
 *
 * 与旧版的关键差异：
 *   · 库存在「提交」时**不再扣减**，改为「确认收货」时扣（真实出库口径）
 *   · stock_deducted 标记该单是否已扣过库存，驳回/作废据此决定是否回补，
 *     不再靠状态推断（历史 confirmed 单迁移后同样标记为已扣，行为一致）
 *
 * 关键保障（沿用）：
 *   1. 幂等：同一 client_request_id 重复提交只生效一次（数据库唯一索引兜底）
 *   2. 并发安全：事务 + 行锁（按物料 id 升序加锁，防死锁）
 *   3. 全部库存变动写 stock_logs，可追溯
 *   4. 扣减前的多个节点都会校验库存，不足即拦下并提示，不留僵尸单
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
const { pushMessage, MSG_TYPE, openidsByRoles, openidsByWarehouseRoles } = require('../services/message')

/**
 * 库存校验：不足直接抛业务错误，并说明差多少（不扣减，只读）
 *
 * ⚠️ 整改（V3 测试 P1-2）：必须先把「同一物料的多行」合并成一条需求再比库存。
 *   原实现是逐行比较，于是「库存 91、同一物料拆两行各 46」每行都不超，
 *   合计 92 却超了 —— 提交照样成功，拆行就能绕过库存校验。
 */
function assertStockEnough(materials, items, scene) {
  // 先按物料合并需求（key 统一成数字，避免驱动返回字符串时对不上）
  const needByMaterial = new Map()
  const rowsByMaterial = new Map()
  for (const it of items) {
    const id = Number(it.material_id)
    needByMaterial.set(id, num(needByMaterial.get(id)) + num(it.quantity))
    rowsByMaterial.set(id, (rowsByMaterial.get(id) || 0) + 1)
  }

  for (const [id, need] of needByMaterial) {
    const material = materials.get(id)
    if (!material) throw errors.badRequest(`物料不存在或已删除（id=${id}）`)

    const stock = num(material.current_stock)
    if (stock < need) {
      const unit = material.unit ? ` ${material.unit}` : ''
      const spec = material.spec ? `（规格 ${material.spec}）` : ''
      // 拆行提交时把「为什么需求变大了」讲清楚，否则使用者会以为系统算错了
      const merged = rowsByMaterial.get(id) > 1 ? '（该物料在本单里分了多行，已按合计计算）' : ''
      throw errors.biz(
        `库存不足：${material.name}${spec} 当前库存 ${stock}${unit}，本次需 ${need}${unit}${merged}。` +
        `${scene}请调整数量，或先入库补货`
      )
    }
  }
}

/**
 * 通知该仓库的仓管员（没有对应仓管时回退通知全部仓管，避免消息石沉大海）
 * @returns {number} 实际投递条数
 */
async function notifyStorekeepers(conn, warehouseId, msg) {
  let openids = await openidsByWarehouseRoles(['storekeeper'], warehouseId, conn)
  if (!openids.length) openids = await openidsByRoles(['storekeeper'], conn)
  if (!openids.length) return 0
  return pushMessage({ toOpenids: openids, ...msg }, conn)
}

/** 通知单个领料员（提交人） */
async function notifyOperator(conn, openid, msg) {
  if (!openid) return 0
  return pushMessage({ toOpenids: [openid], ...msg }, conn)
}

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
 * 厂长（纯 director）只能从成品仓发起出库
 * ------------------------------------------------------------
 * 用户口径（2026-10-09）：「厂长面板加一个成品仓出库功能，发起以后单子到成品仓
 * 管理员、进入拣货流程，拣完货以后通知厂长确认」。
 * 所以只放成品仓，配件仓仍然必须走仓管开单 —— 否则厂长等于绕开仓管动配件仓的账。
 *
 * 判定用「纯 director」：同时兼着仓管/管理员的人按原有仓库范围走，不受这条限制。
 * 拿不到成品仓（仓库被删/改了 code）时放行，不因为配置缺失把功能整死。
 */
async function assertDirectorWarehouse(user, wid) {
  const roles = Array.isArray(user.roles) ? user.roles : []
  const isPureDirector = roles.includes('director') &&
    !roles.some((r) => ['storekeeper', 'boss', 'admin'].includes(r))
  if (!isPureDirector) return

  const chengpinId = await resolveWarehouseId('chengpin')
  if (!chengpinId) return
  if (Number(wid) !== Number(chengpinId)) {
    throw errors.forbidden('厂长只能从成品仓发起出库；配件仓领料请找配件仓管开单')
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

  // 领料员可做「领用」和「报废」；报废必须带现场照片+备注（谁都能开报废单的话，
  // 没有照片凭证就会出现「账面上看不出东西去哪了」的窟窿）。
  // 销售等其他类型仍只能由仓管/老板开。
  const myRoles = Array.isArray(ctx.user.roles) ? ctx.user.roles : []
  const isPureOut =
    myRoles.includes('out') && !myRoles.some((r) => ['storekeeper', 'boss', 'admin', 'purchase'].includes(r))
  if (isPureOut && !['lingyong', 'baofei', 'repair'].includes(type)) {
    return fail(403, '领料员只能提交「领用」「维修」或「报废」；销售等请找仓管或老板开单')
  }
  const attachment = String(data.attachment || '').trim()
  if (type === 'baofei') {
    if (!attachment) return fail(400, '报废必须上传现场照片')
    if (!remark.trim()) return fail(400, '报废必须填写备注（报废原因）')
  }

  // 前端显式指定的仓库（可为空，为空时以物料档案所在仓库为准）
  let requestedWid = null
  if (data.warehouse_id !== undefined && data.warehouse_id !== null && data.warehouse_id !== '') {
    requestedWid = await resolveWarehouseId(data.warehouse_id)
    if (!requestedWid) return fail(400, '所选仓库不存在')
    // 快速失败：无权操作的仓库直接拒绝，不必等事务
    ctx.requireWarehouseAccess(requestedWid, '出库单')
    // 快速失败：厂长只能开成品仓的单（配件仓要走仓管）
    await assertDirectorWarehouse(ctx.user, requestedWid)
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
        // 权威判定放在这里：requestedWid 可以不传，物料归属才是最终事实
        await assertDirectorWarehouse(ctx.user, wid)

        // 3. 生成单号
        const orderNo = await nextOrderNo(conn, 'outbound')

        // 4. 校验库存是否充足（**此处不扣减**）
        //    流程重构 V2：库存在领料员「确认收货」时才真正出账，
        //    所以提交这一步只做「够不够」的预检，避免提交完才发现发不出货。
        //    例外：领料员不查库存（他们也看不到库存数）——缺不缺货由仓管确认时把关、不够就退单。
        if (!isPureOut) {
          assertStockEnough(matMap, items, '提交领料单时校验失败，')
        }
        for (const it of items) {
          const material = matMap.get(it.material_id)
          it.material_name = material.name
          it.material_spec = material.spec || ''
          it.unit = material.unit || ''
        }

        // 5. 主单
        const mainRes = await execute(
          `INSERT INTO outbound_orders
             (order_no, warehouse_id, type, operator_openid, operator_name, remark, attachment, status,
              client_request_id, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NOW(), NOW())`,
          [orderNo, wid, type, operator.openid, operator.name, remark, attachment, ctx.clientRequestId || null],
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
          detail: `提交领料单 ${orderNo}（${typeText('outbound', type)}），共 ${items.length} 项`, ip: ctx.ip
        })

        // 8. 通知仓管员来确认（消息与单据同事务，不会出现「单在、消息没了」）
        await notifyStorekeepers(conn, wid, {
          type: MSG_TYPE.OUTBOUND_SUBMITTED,
          title: '有新的领料单待确认',
          content: `${operator.name} 提交了 ${orderNo}，共 ${items.length} 项，请及时确认并拣货`,
          refType: 'outbound', refId: orderId, refNo: orderNo
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

  return ok({ _id: result.orderId, order_no: result.orderNo }, '领料单已提交，等待仓管确认拣货')
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
  // 2026-10-09 老板只读：cancel 没有 roleRules 条目（走的是这里的内部分支），
  //   原先认 ['boss','admin'] → 老板照样能撤别人的单、撤交接中的单。
  //   这里同步收紧为只认 admin（仓管在下面按状态单独放行）。
  const isManager = hasAnyRole(ctx.user, ['admin'])
  const isOwner = order.operator_openid === identityOf(ctx.user)

  if (order.status === 'cancelled') return fail(400, '该单据已作废')
  if (order.status === 'rejected') return fail(400, '该单据已被驳回，无需作废')

  // 待确认：本人随时可撤（还没动库存，无副作用）；管理员不受限
  // （旧规则「10 分钟内」已废除——实测用户回头撤单必被这个时限拦住，
  //   而 pending 态撤单没有任何副作用，时限纯属添堵）
  if (order.status === 'pending') {
    if (!isOwner && !isManager) return fail(403, '只能撤销自己提交的单据')
  }

  // 待拣货：货还在架上、库存也还没扣，提交人可以自己撤单（撤销没有副作用）
  if (order.status === 'picking'
    && !isOwner && !isManager && !hasAnyRole(ctx.user, ['storekeeper'])) {
    return fail(403, '只能撤销自己提交的单据')
  }

  // 待收货：货已经拣完、正在交接，提交人不能自己撤，必须找仓管
  // （2026-10-09 老板只读：这里去掉 boss，老板不再能撤交接中的单）
  if (order.status === 'receiving'
    && !hasAnyRole(ctx.user, ['storekeeper', 'admin'])) {
    return fail(403, '货物已拣完正在交接，不能自行撤销，请联系仓管处理')
  }

  // 已完成（库存已扣）：只有管理员可作废（2026-10-09 老板只读，已从名单里去掉 boss），
  //   作废会回补库存，属于账目调整
  // 已完成的单作废要回补库存，属于账目调整，只留给「管理员」这个角色
  if (order.status === 'completed' && !hasAnyRole(ctx.user, ['admin'])) {
    return fail(403, '该单据已完成出库，作废会回补库存；如需作废请联系系统管理员')
  }

  if (!['pending', 'picking', 'receiving', 'completed'].includes(order.status)) {
    return fail(400, `当前状态「${statusText(order.status)}」不支持作废`)
  }

  // 只有真正扣过库存的单才需要回补（流程重构 V2：扣减发生在确认收货）
  const deducted = Number(order.stock_deducted) === 1

  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ?', [id])

  await withTransaction(async (conn) => {
    if (deducted) {
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
    }

    // 作废人 / 原因留痕（整改 P1-2-06：原来只改状态，看不出是谁停的）
    await execute(
      `UPDATE outbound_orders
          SET status = 'cancelled', cancelled_at = NOW(), stock_deducted = 0,
              cancel_operator_openid = ?, cancel_operator_name = ?, cancel_reason = ?
        WHERE id = ?`,
      [operator.openid, operator.name, reason || null, id],
      conn
    )

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      role: (ctx.user.roles || []).join(','),
      action: 'outbound_cancel', targetType: 'order', targetId: id,
      detail: `作废领料单 ${order.order_no}${deducted ? '，库存已回补' : '（未扣库存，无需回补）'}${reason ? '，原因：' + reason : ''}`,
      ip: ctx.ip
    })
  })

  return ok(null, deducted ? '已作废，库存已回补' : '已作废（该单尚未扣库存，无需回补）')
}

/** 并发被人抢先时的哨兵错误（用业务错误包一层，便于统一提示） */
function concurrentError() {
  const e = errors.biz('该单据状态刚刚已变化，请刷新后重试')
  e.__concurrent = true
  return e
}

/**
 * 确认领料单：待确认 → 待拣货（仓管 / 老板 / 管理员）
 * 幂等：已经进入后续任何阶段的，直接告知当前进度，不再重复写日志
 */
async function confirm(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM outbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  ctx.requireWarehouseAccess(order.warehouse_id, '该单据')

  // 幂等：已被确认过（进入拣货及之后任一阶段）
  if (['picking', 'receiving', 'completed'].includes(order.status)) {
    return ok(
      {
        duplicated: true,
        confirmed_at: order.confirmed_at,
        confirm_operator_name: order.confirm_operator_name
      },
      `该单据已由「${order.confirm_operator_name || '他人'}」确认（当前：${statusText(order.status)}），无需重复确认`
    )
  }
  if (order.status !== 'pending') {
    return fail(400, `只有待确认的单据可以确认（当前状态：${statusText(order.status)}）`)
  }

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ?', [id])
  // 报废单：没有「领走」这回事，仓管确认 = 当场报废出库、直接扣库存
  const isScrap = order.type === 'baofei'

  let res
  try {
    res = await withTransaction(async (conn) => {
      // 确认这一步再核一次库存：提交到确认之间，料可能已被别的单领走
      const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))
      assertStockEnough(matMap, items, '确认时校验失败，')

      if (isScrap) {
        // 先抢状态再扣库存（扣失败连带回滚状态）
        const upd = await execute(
          `UPDATE outbound_orders
              SET status = 'completed', stock_deducted = 1,
                  confirm_operator_openid = ?, confirm_operator_name = ?, confirmed_at = NOW(),
                  receive_operator_openid = ?, receive_operator_name = ?, received_at = NOW()
            WHERE id = ? AND status = 'pending'`,
          [operator.openid, operator.name, operator.openid, operator.name, id],
          conn
        )
        if (!upd.affectedRows) throw concurrentError()

        for (const it of items) {
          const material = matMap.get(it.material_id)
          if (!material) throw errors.badRequest(`物料不存在或已删除（id=${it.material_id}）`)
          await deductForOutbound(conn, {
            material,
            quantity: it.quantity,
            orderNo: order.order_no,
            operator,
            remark: `报废出库（${operator.name} 确认，凭证：照片+原因）`
          })
        }
        return upd
      }

      const upd = await execute(
        `UPDATE outbound_orders
            SET status = 'picking', confirm_operator_openid = ?, confirm_operator_name = ?, confirmed_at = NOW()
          WHERE id = ? AND status = 'pending'`,
        [operator.openid, operator.name, id],
        conn
      )
      if (!upd.affectedRows) throw concurrentError()
      return upd
    })
  } catch (err) {
    if (err && err.__concurrent) {
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
    throw err
  }

  await writeOpLog(null, {
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'outbound_confirm', targetType: 'order', targetId: id,
    detail: isScrap
      ? `确认报废单 ${order.order_no}，库存已扣减（报废出库）`
      : `确认领料单 ${order.order_no}，进入待拣货`, ip: ctx.ip
  })

  // 报废办结：回执给提交人
  if (isScrap && order.operator_openid) {
    await notifyOperator(null, order.operator_openid, {
      type: MSG_TYPE.OUTBOUND_RECEIVED,
      title: '报废申请已确认',
      content: `${order.order_no} 已由${operator.name}确认报废，库存已扣减`,
      refType: 'outbound', refId: id, refNo: order.order_no
    })
  }

  return ok({ status: isScrap ? 'completed' : 'picking' }, isScrap ? '已确认报废，库存已扣减' : '已确认，请按清单拣货')
}

/**
 * 拣货完成：待拣货 → 待收货（仓管 / 老板 / 管理员）
 * 做完这一步给领料员发消息，他不必一直刷页面等
 */
async function pickDone(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM outbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  ctx.requireWarehouseAccess(order.warehouse_id, '该单据')

  if (['receiving', 'completed'].includes(order.status)) {
    return ok(
      { duplicated: true, picked_at: order.picked_at },
      `该单据已拣货完成（当前：${statusText(order.status)}），无需重复操作`
    )
  }
  if (order.status !== 'picking') {
    return fail(400, `只有待拣货的单据可以标记拣货完成（当前状态：${statusText(order.status)}）`)
  }

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ?', [id])

  try {
    await withTransaction(async (conn) => {
      // 拣货完成时最后一次核库存：拣不出来就没法往下走
      const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))
      assertStockEnough(matMap, items, '拣货完成时校验失败，')

      const upd = await execute(
        `UPDATE outbound_orders
            SET status = 'receiving', pick_operator_openid = ?, pick_operator_name = ?, picked_at = NOW()
          WHERE id = ? AND status = 'picking'`,
        [operator.openid, operator.name, id],
        conn
      )
      if (!upd.affectedRows) throw concurrentError()

      await writeOpLog(conn, {
        openid: operator.openid, userName: operator.name,
        role: (ctx.user.roles || []).join(','),
        action: 'outbound_pick_done', targetType: 'order', targetId: id,
        detail: `领料单 ${order.order_no} 拣货完成，等待领料员收货`, ip: ctx.ip
      })

      // 通知领料员来收货（与状态变更同事务）
      await notifyOperator(conn, order.operator_openid, {
        type: MSG_TYPE.OUTBOUND_PICKED,
        title: '你的领料单已拣货完成，请来收货',
        content: `${order.order_no} 已完成拣货（共 ${items.length} 项），请到场核对实物后点「确认收货」`,
        refType: 'outbound', refId: id, refNo: order.order_no
      })
    })
  } catch (err) {
    if (err && err.__concurrent) {
      const latest = await queryOne('SELECT * FROM outbound_orders WHERE id = ?', [id])
      return ok(
        { duplicated: true, picked_at: latest ? latest.picked_at : null },
        '该单据刚刚已被标记拣货完成，无需重复操作'
      )
    }
    throw err
  }

  return ok({ status: 'receiving' }, '拣货完成，已通知领料员来收货')
}

/**
 * 确认收货：待收货 → 已完成（领料员本人 / 仓管 / 老板 / 管理员）
 * ★ 库存在这一步才真正扣减 —— 也就是「真实出库」的口径
 */
async function receive(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '单据 ID 无效')

  const order = await queryOne('SELECT * FROM outbound_orders WHERE id = ? AND is_deleted = 0', [id])
  if (!order) return fail(404, '单据不存在')

  const isOwner = order.operator_openid === identityOf(ctx.user)
  const isManager = hasAnyRole(ctx.user, ['storekeeper', 'boss', 'admin'])
  if (!isOwner && !isManager) {
    return fail(403, '只有该单的领料人或仓管可以确认收货')
  }
  ctx.requireWarehouseAccess(order.warehouse_id, '该单据')

  if (order.status === 'completed') {
    return ok(
      { duplicated: true, received_at: order.received_at, stock_deducted: true },
      `该单据已于 ${order.received_at || ''} 确认收货，无需重复操作`
    )
  }
  if (order.status !== 'receiving') {
    return fail(400, `只有待收货的单据可以确认收货（当前状态：${statusText(order.status)}）`)
  }

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ?', [id])

  // 迁移前创建的历史单：老流程在「提交」时就扣过库存（迁移脚本已标记），
  // 这里只改状态，不能再扣一次，否则账实不符。
  const alreadyDeducted = Number(order.stock_deducted) === 1

  try {
    await withTransaction(async (conn) => {
      // 先条件更新抢单，抢到才扣库存（扣库存失败会连带回滚状态）
      const upd = await execute(
        `UPDATE outbound_orders
            SET status = 'completed', stock_deducted = 1,
                receive_operator_openid = ?, receive_operator_name = ?, received_at = NOW()
          WHERE id = ? AND status = 'receiving'`,
        [operator.openid, operator.name, id],
        conn
      )
      if (!upd.affectedRows) throw concurrentError()

      // ★ 真实出库：此刻才扣库存，并逐笔写 stock_logs
      if (!alreadyDeducted) {
        const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))
        for (const it of items) {
          const material = matMap.get(it.material_id)
          if (!material) throw errors.badRequest(`物料不存在或已删除（id=${it.material_id}）`)
          await deductForOutbound(conn, {
            material,
            quantity: it.quantity,
            orderNo: order.order_no,
            operator,
            remark: `领料出库-${typeText('outbound', order.type)}（${operator.name} 确认收货）`
          })
        }
      }

      await writeOpLog(conn, {
        openid: operator.openid, userName: operator.name,
        role: (ctx.user.roles || []).join(','),
        action: 'outbound_receive', targetType: 'order', targetId: id,
        detail: `领料单 ${order.order_no} 确认收货，` +
          (alreadyDeducted ? '该单为历史单据（提交时已扣库存），本次不再重复扣减' : `扣减库存 ${items.length} 项`),
        ip: ctx.ip
      })

      // 回执给仓管：这单彻底办完了
      await notifyStorekeepers(conn, order.warehouse_id, {
        type: MSG_TYPE.OUTBOUND_RECEIVED,
        title: '领料单已完成收货',
        content: `${order.order_no} 已由${operator.name}确认收货，库存已扣减`,
        refType: 'outbound', refId: id, refNo: order.order_no
      })
    })
  } catch (err) {
    if (err && err.__concurrent) {
      const latest = await queryOne('SELECT * FROM outbound_orders WHERE id = ?', [id])
      return ok(
        { duplicated: true, received_at: latest ? latest.received_at : null },
        latest && latest.status === 'completed'
          ? '该单据刚刚已被确认收货，无需重复操作'
          : '该单据状态已变化，请刷新后重试'
      )
    }
    throw err
  }

  return ok({ status: 'completed' }, '已确认收货，库存已扣减')
}

/**
 * 驳回领料单（仓管 / 老板 / 管理员）
 * 可驳回的状态：待确认 / 待拣货 / 待收货（拣货时发现库存不够就退回，很常见）
 * 已完成只能作废，不能驳回 —— 那批料已经出账了
 */
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
  if (!['pending', 'picking', 'receiving'].includes(order.status)) {
    return fail(400, `当前状态「${statusText(order.status)}」不支持驳回（已完成的单据请联系管理员作废）`)
  }

  // 只有真正扣过库存的单才需要回补（流程重构 V2：扣减发生在确认收货）
  const deducted = Number(order.stock_deducted) === 1

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM outbound_order_items WHERE order_id = ?', [id])

  try {
    await withTransaction(async (conn) => {
      if (deducted) {
        const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))

        // 驳回 = 单据不成立 → 已扣的库存必须回补，否则账实不符
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
      }

      const upd = await execute(
        `UPDATE outbound_orders
            SET status = 'rejected', reject_reason = ?, reject_operator_openid = ?,
                reject_operator_name = ?, rejected_at = NOW(), stock_deducted = 0
          WHERE id = ? AND status IN ('pending','picking','receiving')`,
        [reason, operator.openid, operator.name, id],
        conn
      )
      if (!upd.affectedRows) throw concurrentError()

      await writeOpLog(conn, {
        openid: operator.openid, userName: operator.name,
        role: (ctx.user.roles || []).join(','),
        action: 'outbound_reject', targetType: 'order', targetId: id,
        detail: `驳回领料单 ${order.order_no}，原因：${reason}${deducted ? '，库存已回补' : ''}`, ip: ctx.ip
      })

      // 通知提交人：被驳回后能立刻知道，并看到原因
      await notifyOperator(conn, order.operator_openid, {
        type: MSG_TYPE.OUTBOUND_REJECTED,
        title: '你的领料单被驳回',
        content: `${order.order_no} 被驳回：${reason}`,
        refType: 'outbound', refId: id, refNo: order.order_no
      })
    })
  } catch (err) {
    if (err && err.__concurrent) {
      return ok({ duplicated: true }, '该单据状态刚刚已变化，请刷新后重试')
    }
    throw err
  }

  return ok(null, deducted ? '已驳回，库存已回补' : '已驳回（该单尚未扣库存，无需回补）')
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

/** 待拣货数量（流程重构 V2：确认之后、拣货之前，也是仓管的待办） */
async function pickingCount(ctx) {
  if (!ctx.user) return fail(401, '请先登录')
  const scope = ctx.warehouseScope('o')
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM outbound_orders o
      WHERE o.status = 'picking' AND o.is_deleted = 0 ${scope.sql}`,
    scope.params
  )
  return ok({ count: row ? row.c : 0 })
}

/**
 * 我的待处理提醒（首页用）
 *   1. 被驳回且由本人提交的单（近 7 天）—— 提醒去改
 *   2. 待收货且由本人提交的单 —— 仓管已拣完货，等他到场确认
 */
async function myNotice(ctx) {
  if (!ctx.user) return fail(401, '请先登录')

  const me = identityOf(ctx.user)

  const rejectedRows = await query(
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

  // 待收货：仓管拣完货等他来收，首页要能一眼看到
  const receivingRows = await query(
    `SELECT o.id, o.order_no, o.status, o.picked_at, o.pick_operator_name,
            o.warehouse_id, w.name AS warehouse_name,
            (SELECT COUNT(*) FROM outbound_order_items i WHERE i.order_id = o.id) AS item_count
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
      WHERE o.is_deleted = 0
        AND o.status = 'receiving'
        AND o.operator_openid = ?
      ORDER BY o.picked_at DESC, o.id DESC
      LIMIT 10`,
    [me]
  )

  return ok({
    rejected_count: num(cnt.c),
    rejected_list: toApi(rejectedRows),
    receiving_count: receivingRows.length,
    receiving_list: toApi(receivingRows)
  })
}

module.exports = {
  name: 'outbound',
  publicActions: [],
  roleRules: {
    // 领料员（out）提交领料清单；仓管可代提交（2026-10-09：老板只读，已收回 boss）
    // 2026-10-09 二改：厂长可在小程序「成品仓出库」发起（服务内 assertDirectorWarehouse
    //   再限定只能开成品仓的单，配件仓仍走仓管）
    submit: ['out', 'purchase', 'storekeeper', 'admin', 'director'],
    confirm: ['storekeeper', 'admin'],
    // 拣货是仓管的活
    pickDone: ['storekeeper', 'admin'],
    // 确认收货：领料员本人（服务内再校一次身份），仓管可代确认
    // 厂长发起成品仓出库后，拣完货要通知他确认，所以这里必须放行 director
    receive: ['out', 'purchase', 'storekeeper', 'admin', 'director'],
    // P1-2：仓管员是实际"退回去"的人，必须给驳回权
    reject: ['storekeeper', 'admin']
  },
  actions: {
    submit, list, detail, cancel,
    confirm, pickDone, receive, reject,
    pendingCount, pickingCount, myNotice
  }
}
