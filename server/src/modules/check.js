/**
 * ============================================================
 * 盘点模块
 * ------------------------------------------------------------
 * 流程：创建任务 → 生成明细（记录账面库存）→ 盘点录入 → 审核 → 差异回写库存
 * 差异回写全部走 stock.js
 *
 * ⚠️ 整改说明（来自 4 角色使用者测试，报告见 docs/4-ROLE-USER-TEST-REPORT.md）：
 *   P0-3.9 盘点「差异」用的是建单时的库存快照，而实际调整按当时的库存算
 *          → 单据说差 5、流水只调了 2.5，同一件事两个数（仓管不敢签字的直接原因）。
 *          现在：提交时刷新账面数；审核时在行锁内再刷新一次并回写单据，
 *          保证「单据差异 === 库存流水实际调整量」，完全对得上。
 *   P0-3.10 实盘数能填负数 → 现在必须是非负整数
 *   P0-2-9  同一物料可重复建多张盘点单挂在待审队列 → 现在拦截「未关闭盘点单已覆盖该物料」
 *   P1-4    审核参数 approved 与实现 approve 不一致 → 现在两个都接受
 *   P1-5    已提交待审的单还能被反复改数 → 现在 pending_review 拒绝再次提交
 *   P1-6    建单撞号直接 500 并泄漏数据库原始报错 → 现在自动重试 + 统一友好提示
 *   P1-7    备注 remark 传入即丢失 → 现在落库并可在详情查看
 *   P1-13   任意角色都能提交盘点结果 → 现在仅仓管/老板/管理员
 *   P2      提交时传不存在的物料被静默忽略 → 现在明确报错
 * ============================================================
 */
const { query, queryOne, execute, withTransaction } = require('../db/pool')
const { ok, fail, errors } = require('../utils/response')
const { toApi, toDbId, num, qty, paging } = require('../utils/format')
const { nonNegativeInt } = require('../utils/validate')
const { statusText } = require('../utils/labels')
const { resolveWarehouseId, resolveWarehouseIdOrDefault } = require('../services/warehouse')
const { lockMaterialsSorted, adjustForCheck } = require('../services/stock')
const { nextOrderNo } = require('../services/orderNo')
const { operatorOf, hasAnyRole, identityOf } = require('../middleware/auth')

/** 盘点单未关闭状态（这些状态下的盘点单会与新建盘点范围冲突） */
const OPEN_STATUS = ['pending', 'in_progress', 'pending_review']

/** 单个盘点单最多包含的物料数（超过需显式确认，避免误建整仓 1700+ 项） */
const FULL_SCAN_WARN_THRESHOLD = 200

async function writeOpLog(conn, p) {
  await execute(
    `INSERT INTO operation_logs (openid, user_name, role, action, target_type, target_id, detail, result, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
    [
      p.openid || '', p.userName || '', p.role || '', p.action || '',
      p.targetType || 'check', String(p.targetId || ''), p.detail || '', p.ip || ''
    ],
    conn || null
  )
}

/** 盘点单可见性：管理角色看全部；其余限可管仓库且是自己创建/被指派的 */
function assertCheckVisible(ctx, check) {
  if (hasAnyRole(ctx.user, ['boss', 'admin'])) return
  ctx.requireWarehouseAccess(check.warehouse_id, '该盘点单')
  const me = identityOf(ctx.user)
  const assignees = Array.isArray(check.assignee_openids) ? check.assignee_openids : []
  if (check.operator_openid !== me && !assignees.includes(me)) {
    throw errors.forbidden('只能查看自己创建或参与的盘点单')
  }
}

/**
 * 创建盘点任务
 * 入参：{ type, warehouse_id, scope:{categories:[],material_ids:[]}, remark, assignee_openids, confirm_full_scan }
 * 兼容：也接受顶层 items:[{material_id}]（早期文档写错字段名，这里兜底）
 */
async function create(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const type = String(data.type || 'full')
  const scope = data.scope || {}
  const assignees = Array.isArray(data.assignee_openids) ? data.assignee_openids : []
  const freeze = data.freeze_stock ? 1 : 0
  const remark = String(data.remark || '')

  const wid = await resolveWarehouseIdOrDefault(data.warehouse_id)
  if (!wid) return fail(400, '请选择要盘点的仓库')
  ctx.requireWarehouseAccess(wid, '盘点单')

  // 范围物料 id：兼容 scope.material_ids 与顶层 items
  let rawIds = Array.isArray(scope.material_ids) ? scope.material_ids.slice() : []
  if (!rawIds.length && Array.isArray(data.items)) {
    rawIds = data.items.map((it) => (it && typeof it === 'object' ? it.material_id : it))
  }
  const materialIds = rawIds.map(toDbId).filter(Boolean).map(Number)
  const categories = (scope.categories || []).filter(Boolean)

  // 按范围查物料
  const where = ['is_deleted = 0', 'warehouse_id = ?']
  const params = [wid]
  if (materialIds.length) {
    where.push(`id IN (${[...new Set(materialIds)].map(() => '?').join(',')})`)
    params.push(...[...new Set(materialIds)])
  }
  if (categories.length) {
    where.push(`category IN (${categories.map(() => '?').join(',')})`)
    params.push(...categories)
  }

  const materials = await query(`SELECT * FROM materials WHERE ${where.join(' AND ')} ORDER BY id`, params)
  if (!materials.length) {
    return fail(400, '所选范围内没有物料，无法创建盘点任务')
  }

  // 全盘守卫：范围为空且物料很多时，必须显式确认，避免误建上千项的单子
  if (!materialIds.length && !categories.length && materials.length > FULL_SCAN_WARN_THRESHOLD && !data.confirm_full_scan) {
    return fail(
      400,
      `你未选择具体物料，这将创建一张覆盖整个仓库、共 ${materials.length} 项的全盘单。` +
      `请在界面上先勾选要盘的物料；如确实要全盘，请二次确认后再提交`
    )
  }

  // 重复盘点拦截：同一物料已被未关闭的盘点单覆盖 → 拒绝（整改 P0-2-9）
  const conflict = await queryOne(
    `SELECT c.check_no, c.status, i.material_name
       FROM stock_checks c
       JOIN stock_check_items i ON i.check_id = c.id
      WHERE c.status IN (${OPEN_STATUS.map(() => '?').join(',')})
        AND i.material_id IN (${materials.map(() => '?').join(',')})
      LIMIT 1`,
    [...OPEN_STATUS, ...materials.map((m) => m.id)]
  )
  if (conflict) {
    return fail(
      409,
      `物料「${conflict.material_name}」已在一张未完成的盘点单（${conflict.check_no}，当前${statusText(conflict.status)}）中，` +
      `请先完成或取消那张单，避免同一物料出现两份互相冲突的盘点结果`
    )
  }

  const operator = operatorOf(ctx.user)
  const cfg = { type, warehouse_id: wid, scope, remark }

  // 单号撞号自动重试（整改 P1-6：原来直接 500 并抛出数据库原始错误）
  let lastErr = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await withTransaction(async (conn) => {
        const checkNo = await nextOrderNo(conn, 'check')

        const mainRes = await execute(
          `INSERT INTO stock_checks
             (check_no, warehouse_id, type, status, freeze_stock, assignee_openids, scope, remark,
              operator_openid, operator_name, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            checkNo, wid, type, freeze,
            JSON.stringify(assignees), JSON.stringify(scope), remark,
            operator.openid, operator.name
          ],
          conn
        )
        const checkId = mainRes.insertId

        for (const m of materials) {
          await execute(
            `INSERT INTO stock_check_items
               (check_id, material_id, material_name, material_spec, unit, book_stock, is_checked)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
            [checkId, m.id, m.name, m.spec, m.unit, m.current_stock],
            conn
          )
        }

        await writeOpLog(conn, {
          openid: operator.openid, userName: operator.name,
          role: (ctx.user.roles || []).join(','),
          action: 'check_create', targetId: checkId,
          detail: `创建盘点任务 ${checkNo}，共 ${materials.length} 项物料${remark ? '，说明：' + remark : ''}`,
          ip: ctx.ip
        })

        return { checkId, checkNo, count: materials.length }
      })

      return ok(
        { _id: result.checkId, check_no: result.checkNo, item_count: result.count },
        `盘点任务已创建，共 ${result.count} 项物料`
      )
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        lastErr = err
        continue // 撞号，换一个单号重试
      }
      throw err
    }
  }
  console.error('[盘点] 单号生成连续冲突', cfg, lastErr && lastErr.message)
  return fail(409, '盘点单号生成冲突，请稍后重试')
}

/** 盘点任务列表 */
async function list(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const { page, pageSize, offset } = paging(data)
  const { status, warehouse_id: warehouseId } = data

  const where = ['c.id > 0']
  const params = []

  if (status) {
    where.push('c.status = ?')
    params.push(String(status))
  }

  // 仓库级数据权限
  const scope = ctx.warehouseScope('c', warehouseId)
  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }

  // 非管理角色：只看自己参与或创建的
  // ⚠️ 整改：原来只用 c.operator_openid = openid，而写入用 openid||username，
  //    账号密码登录（openid 为空）时两边不匹配 → 自己建的单据列表永远为空
  if (!hasAnyRole(ctx.user, ['boss', 'admin'])) {
    where.push('(c.operator_openid = ? OR JSON_CONTAINS(COALESCE(c.assignee_openids, JSON_ARRAY()), JSON_QUOTE(?)))')
    params.push(identityOf(ctx.user), identityOf(ctx.user))
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM stock_checks c WHERE ${whereSql}`, params)
  const rows = await query(
    `SELECT c.*, w.name AS warehouse_name,
            (SELECT COUNT(*) FROM stock_check_items i WHERE i.check_id = c.id) AS item_count,
            (SELECT COUNT(*) FROM stock_check_items i WHERE i.check_id = c.id AND i.is_checked = 1) AS checked_count,
            (SELECT COUNT(*) FROM stock_check_items i WHERE i.check_id = c.id AND i.difference IS NOT NULL AND i.difference <> 0) AS diff_count
       FROM stock_checks c
       LEFT JOIN warehouses w ON w.id = c.warehouse_id
      WHERE ${whereSql}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  for (const r of rows) r.status_text = statusText(r.status)

  return ok({ list: toApi(rows), total: cnt.total, page, pageSize })
}

/** 盘点详情（含明细） */
async function detail(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '盘点单 ID 无效')

  const check = await queryOne(
    `SELECT c.*, w.name AS warehouse_name
       FROM stock_checks c LEFT JOIN warehouses w ON w.id = c.warehouse_id
      WHERE c.id = ?`,
    [id]
  )
  if (!check) return fail(404, '盘点任务不存在')

  assertCheckVisible(ctx, check)

  const items = await query(
    'SELECT * FROM stock_check_items WHERE check_id = ? ORDER BY id',
    [id]
  )

  // 给未盘明细补当前库存，方便录入时对照（实物数 vs 系统数）
  const ids = items.map((i) => i.material_id)
  if (ids.length) {
    const mats = await query(
      `SELECT id, current_stock, unit FROM materials WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    )
    const map = new Map(mats.map((m) => [Number(m.id), m]))
    for (const it of items) {
      const m = map.get(Number(it.material_id))
      it.current_stock = m ? num(m.current_stock) : 0
      it.unit = it.unit || (m ? m.unit : '')
    }
  }

  const summary = {
    total: items.length,
    checked: items.filter((i) => i.is_checked).length,
    diff: items.filter((i) => i.difference !== null && num(i.difference) !== 0).length,
    surplus: items.filter((i) => i.difference !== null && num(i.difference) > 0).length,
    loss: items.filter((i) => i.difference !== null && num(i.difference) < 0).length
  }

  const apiCheck = toApi(check)
  apiCheck.status_text = statusText(check.status)
  apiCheck.items = toApi(items)
  apiCheck.summary = summary

  return ok(apiCheck)
}

/**
 * 提交盘点结果
 * 入参：{ id, items:[{material_id, actual_stock}] }
 *
 * 关键：把每条明细的 book_stock 刷新为「提交这一刻的库存」，
 *       使 difference 一开始就等于将要发生的调整量。
 *       （审核时还会在行锁内再刷新一次并回写，最终完全一致）
 */
async function submit(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const items = Array.isArray(data.items) ? data.items : []
  if (!id) return fail(400, '盘点单 ID 无效')
  if (!items.length) return fail(400, '请至少录入一项盘点结果')

  const check = await queryOne('SELECT * FROM stock_checks WHERE id = ?', [id])
  if (!check) return fail(404, '盘点任务不存在')

  assertCheckVisible(ctx, check)

  if (['completed', 'cancelled'].includes(check.status)) {
    return fail(400, `该盘点任务已${check.status === 'completed' ? '完成' : '作废'}，无法录入`)
  }
  // 整改 P1-5：已提交待审的单不允许再改数，否则老板看到的和你交的不是同一份
  if (check.status === 'pending_review') {
    return fail(
      400,
      '该盘点单已提交，正在等待老板审核，不能再修改。如需重盘，请让老板先退回'
    )
  }

  const operator = operatorOf(ctx.user)

  // 先校验所有行（不存在的物料明确报错，而不是静默吃掉）
  const rows = await query('SELECT * FROM stock_check_items WHERE check_id = ?', [id])
  const byMaterial = new Map(rows.map((r) => [Number(r.material_id), r]))

  const parsed = []
  const unknown = []
  const seen = new Set()
  for (const it of items) {
    const mid = toDbId(it.material_id)
    if (!mid) {
      throw errors.badRequest('盘点明细缺少物料 ID')
    }
    if (seen.has(Number(mid))) continue // 同一物料只取一次
    seen.add(Number(mid))

    const row = byMaterial.get(Number(mid))
    if (!row) {
      unknown.push(Number(mid))
      continue
    }
    // 实盘数：非负整数（整改 P0-3.10：原来能填 -3）
    const actual = nonNegativeInt(it.actual_stock, `「${row.material_name}」的实盘数量`)
    parsed.push({ row, actual })
  }

  if (unknown.length) {
    return fail(
      400,
      `有 ${unknown.length} 项物料不在本次盘点范围内（物料编号 ${unknown.join('、')}），` +
      `请核对后重新提交，避免漏盘`
    )
  }
  if (!parsed.length) return fail(400, '没有可录入的盘点明细')

  const result = await withTransaction(async (conn) => {
    let recorded = 0
    let diffCount = 0

    for (const p of parsed) {
      // 刷新账面数 = 提交这一刻的真实库存
      const live = await queryOne(
        'SELECT current_stock FROM materials WHERE id = ?',
        [p.row.material_id],
        conn
      )
      const book = live ? num(live.current_stock) : num(p.row.book_stock)
      const difference = qty(p.actual - book)

      await execute(
        `UPDATE stock_check_items
            SET actual_stock = ?, difference = ?, book_stock = ?, is_checked = 1
          WHERE id = ?`,
        [p.actual, difference, book, p.row.id],
        conn
      )
      recorded++
      if (difference !== 0) diffCount++
    }

    await execute(
      "UPDATE stock_checks SET status = 'pending_review', updated_at = NOW() WHERE id = ? AND status IN ('pending','in_progress')",
      [id],
      conn
    )

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      role: (ctx.user.roles || []).join(','),
      action: 'check_submit', targetId: id,
      detail: `提交盘点结果 ${check.check_no}，录入 ${recorded} 项，其中差异 ${diffCount} 项`,
      ip: ctx.ip
    })

    return { recorded, diffCount }
  })

  return ok(
    { recorded: result.recorded, diff: result.diffCount },
    `盘点结果已提交，共 ${result.recorded} 项（差异 ${result.diffCount} 项），等待老板审核`
  )
}

/**
 * 审核盘点差异
 * 入参：{ id, approve: true|false, remark }   —— 同时兼容 approved 写法
 * approve=true 时按差异回写库存
 *
 * 关键（整改 P0-3.9）：在行锁内重新取库存，并把「账面数/差异」回写单据，
 * 保证单据上的差异 === 库存流水的实际调整量，二者永远一致。
 */
async function review(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '盘点单 ID 无效')

  // 兼容 approve / approved 两种写法（整改 P1-4）
  const rawApprove = data.approve !== undefined ? data.approve : data.approved
  const approve = rawApprove === undefined ? true : !(rawApprove === false || rawApprove === 'false' || rawApprove === 0)
  const remark = String(data.remark || '')

  const check = await queryOne('SELECT * FROM stock_checks WHERE id = ?', [id])
  if (!check) return fail(404, '盘点任务不存在')
  ctx.requireWarehouseAccess(check.warehouse_id, '盘点单')

  if (check.status !== 'pending_review') {
    return fail(400, `当前状态「${statusText(check.status)}」不支持审核`)
  }

  const items = await query(
    'SELECT * FROM stock_check_items WHERE check_id = ? AND is_checked = 1',
    [id]
  )
  if (!items.length) return fail(400, '没有已录入的盘点结果')

  const operator = operatorOf(ctx.user)

  // ---------- 退回：不动物流，只改状态 ----------
  if (!approve) {
    await withTransaction(async (conn) => {
      await execute(
        `UPDATE stock_checks
            SET status = 'in_progress', reviewer_openid = ?, reviewer_name = ?, reviewed_at = NOW(), updated_at = NOW()
          WHERE id = ?`,
        [operator.openid, operator.name, id],
        conn
      )
      await writeOpLog(conn, {
        openid: operator.openid, userName: operator.name,
        role: (ctx.user.roles || []).join(','),
        action: 'check_review_reject', targetId: id,
        detail: `退回盘点 ${check.check_no}，要求重新盘点${remark ? '，原因：' + remark : ''}` +
          '（库存未做任何调整）',
        ip: ctx.ip
      })
    })
    return ok({ approved: false, adjusted: 0 }, '已退回，库存未做任何调整，请重新盘点后再提交')
  }

  // ---------- 通过：按差异回写库存 ----------
  const applied = await withTransaction(async (conn) => {
    // 行锁：锁住全部明细物料（按 id 升序，与其他模块加锁顺序一致，避免死锁）
    const matMap = await lockMaterialsSorted(conn, items.map((i) => i.material_id))

    let count = 0
    const details = []

    for (const it of items) {
      const material = matMap.get(Number(it.material_id))
      if (!material) continue

      // 以「审核这一刻的真实库存」为账面数，并把结果回写单据
      const liveBook = num(material.current_stock)
      const actual = num(it.actual_stock)
      const realDiff = qty(actual - liveBook)

      const bookChanged = Math.abs(liveBook - num(it.book_stock)) > 1e-9
      if (bookChanged || Math.abs(realDiff - num(it.difference)) > 1e-9) {
        await execute(
          'UPDATE stock_check_items SET book_stock = ?, difference = ? WHERE id = ?',
          [liveBook, realDiff, it.id],
          conn
        )
      }

      if (realDiff === 0) continue

      await adjustForCheck(conn, {
        material,
        actualStock: actual,
        orderNo: check.check_no,
        operator,
        remark:
          `盘点差异调整：账 ${liveBook} → 实 ${actual}` +
          (bookChanged ? `（建单时账面 ${it.book_stock}，盘期间发生过出入库）` : '')
      })
      count++
      details.push(`${it.material_name} 账${liveBook}→实${actual}（差 ${realDiff > 0 ? '+' : ''}${realDiff}）`)
    }

    await execute(
      `UPDATE stock_checks
          SET status = 'completed', reviewer_openid = ?, reviewer_name = ?,
              reviewed_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      [operator.openid, operator.name, id],
      conn
    )

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      role: (ctx.user.roles || []).join(','),
      action: 'check_review', targetId: id,
      detail: `审核通过盘点 ${check.check_no}，调整 ${count} 项差异：${details.join('；') || '无'}` +
        (remark ? `；备注：${remark}` : ''),
      ip: ctx.ip
    })

    return { count, details }
  })

  return ok(
    { approved: true, adjusted: applied.count, details: applied.details },
    applied.count > 0
      ? `审核完成，已按实盘数调整 ${applied.count} 项库存（单据差异与库存流水完全一致）`
      : '审核完成，账实相符，无需调整'
  )
}

/** 作废盘点任务 */
async function cancel(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const reason = String(data.reason || '')
  if (!id) return fail(400, '盘点单 ID 无效')

  const check = await queryOne('SELECT * FROM stock_checks WHERE id = ?', [id])
  if (!check) return fail(404, '盘点任务不存在')

  ctx.requireWarehouseAccess(check.warehouse_id, '盘点单')

  // 管理角色可作废任意；创建人可作废自己未完成的
  const isManager = hasAnyRole(ctx.user, ['boss', 'admin'])
  const isOwner = check.operator_openid === identityOf(ctx.user)
  if (!isManager && !isOwner) {
    return fail(403, '只能作废自己创建的盘点任务')
  }
  if (check.status === 'completed') return fail(400, '已完成的盘点任务不能作废')

  const operator = operatorOf(ctx.user)
  await execute("UPDATE stock_checks SET status = 'cancelled', updated_at = NOW() WHERE id = ?", [id])

  await writeOpLog(null, {
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'check_cancel', targetId: id,
    detail: `作废盘点任务 ${check.check_no}，原因：${reason || '未填写'}`, ip: ctx.ip
  })

  return ok(null, '盘点任务已作废')
}

module.exports = {
  name: 'check',
  publicActions: [],
  roleRules: {
    create: ['boss', 'admin', 'storekeeper'],
    // 整改 P1-13：原先没写 submit，任何角色（含出库员、采购员）都能录入盘点结果
    submit: ['storekeeper', 'boss', 'admin'],
    review: ['boss', 'admin'],
    cancel: ['storekeeper', 'boss', 'admin']
  },
  actions: { create, list, detail, submit, review, cancel }
}
