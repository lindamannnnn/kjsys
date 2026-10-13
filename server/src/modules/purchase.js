/**
 * ============================================================
 * 采购模块（流程重构 V2 · P4）
 * ------------------------------------------------------------
 * 流程：仓管发任务 → 采购员领取 → 采购录入（单价/购买方式/淘宝单号/单据）
 *       → 仓管验货**逐项登记到货（点「到货」当场加库存）**→ 全部处理完办结
 *
 * 状态机：
 *   open（待领取，可指定人）→ taken（采购中）→ purchased（已购买，待收料）
 *                                       ↘ receiving（收货中，已有货件登记）
 *                                       ↘ received（已收货办结，终态）
 *   任一进行中状态可 cancelled（仓管/管理员）
 *   purchased/receiving 可被仓管 rejectBack（收料不通过）→ 退回 taken 让采购员补录
 *
 * ⚠️ 2026-10-09 老板拍板改版：**「到货」= 真入库**
 *   原设计「点『到货』只登记数量 → 再点『入库』才加库存」，货已进仓库但库存不动，与实际不符。
 *   现改为：仓管填实到数量点「到货」，库存**当场加上**，不需要再点一次「入库」。
 *   · 填的是该项「实到总数」（分次到货就改大它），系统按**差额**入账：
 *       delta = 实到总数 − 已入账数量
 *       delta > 0 → 生成一张入库单（每批到货一张）+ addForInbound 加库存
 *       delta < 0 → 上次报多了：把最近一张该明细的入库单作废冲回，直到账对得上
 *   · 已入账数量记在 purchase_task_items.stocked_qty；入库单靠 inbound_orders.source_item_id 反查
 *   · 办结（receive）**不再加库存**，只把任务状态推到 received 并汇总入库单号
 *
 * 设计要点：
 *   · 采购员**不接触库存**：填完单据交给仓管，收货入库由仓管完成
 *   · 「单号」在发布任务时就生成（CG-日期-序号），采购员领取后即可拿它去下单
 *   · 入库复用 services/stock 的 addForInbound / restoreForInboundCancel，加权成本口径与手工入库一致
 *   · 每一步都发站内消息，双方不用互相追
 * ============================================================
 */
const { query, queryOne, execute, withTransaction } = require('../db/pool')
const { ok, fail, errors } = require('../utils/response')
const { toApi, toDbId, num, money, paging, qty } = require('../utils/format')
const { positiveInt } = require('../utils/validate')
const { resolveWarehouseId } = require('../services/warehouse')
const { lockMaterialsSorted, addForInbound, restoreForInboundCancel } = require('../services/stock')
const { nextOrderNo } = require('../services/orderNo')
const { operatorOf, hasAnyRole, identityOf, isCostHiddenUser, isPartsWarehouse, PARTS_WAREHOUSE_CODE } = require('../middleware/auth')
const { pushMessage, MSG_TYPE, openidsByRoles, openidsByWarehouseRoles } = require('../services/message')

/** 购买方式固定选项（流程评审定稿：淘宝 / 京东 / 线下 / 其他） */
// 2026-10-09：加入 1688 / 拼多多（用户提的常用渠道）。
// ⚠️ 这里改了必须同步改小程序 pages/purchase/task-detail.vue 的 channels 常量，
//    以及后台 admin/src/views/purchase/tasks.vue 的渠道展示（若有硬编码列表）。
// 「其他」是兜底项，选它必须写 channel_remark，否则账上只剩「其他」两个字，查不出货从哪来。
const PURCHASE_CHANNELS = ['淘宝', '京东', '1688', '拼多多', '线下', '其他']

/** 选「其他」时必须补充说明 */
const OTHER_CHANNEL = '其他'

/**
 * 采购任务只针对配件仓（2026-10-12 用户定稿）：
 * 成品仓存的是成品（车间生产入库），不需要采购 → 成品仓相关动作全部收口。
 * 用在 list / myTodoCount 的 WHERE 里；写在这里复用，避免三处硬编码。
 * ⚠️ 用表里就有的列 warehouse_id，不带别名前缀，保证两种写法（带/不带别名）都成立。
 */
const PARTS_SCOPE_SQL = `warehouse_id IN (SELECT id FROM warehouses WHERE code = '${PARTS_WAREHOUSE_CODE}' AND is_deleted = 0)`

const STATUS_TEXT = {
  open: '待领取',
  taken: '采购中',
  purchased: '待收料',
  receiving: '收货中',
  received: '已入库',
  cancelled: '已取消'
}

function statusText(s) {
  return STATUS_TEXT[s] || String(s || '')
}

async function writeOpLog(conn, p) {
  await execute(
    `INSERT INTO operation_logs (openid, user_name, role, action, target_type, target_id, detail, result, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
    [
      p.openid || '', p.userName || '', p.role || '', p.action || '',
      p.targetType || 'purchase_task', String(p.targetId || ''), p.detail || '', p.ip || ''
    ],
    conn
  )
}

/** 通知该仓库的仓管（没有则回退全部仓管） */
async function notifyStorekeepers(conn, warehouseId, msg) {
  let openids = await openidsByWarehouseRoles(['storekeeper'], warehouseId, conn)
  if (!openids.length) openids = await openidsByRoles(['storekeeper'], conn)
  if (!openids.length) return 0
  return pushMessage({ toOpenids: openids, ...msg }, conn)
}

/** 任务可见性：老板/管理员/仓管看本仓全部，采购员看「自己领的」或「可领的」 */
function assertTaskVisible(ctx, task) {
  if (hasAnyRole(ctx.user, ['boss', 'admin'])) return
  if (hasAnyRole(ctx.user, ['storekeeper'])) {
    ctx.requireWarehouseAccess(task.warehouse_id, '该采购任务')
    return
  }
  const me = identityOf(ctx.user)
  const isTaker = task.taker_openid === me
  const canTake = task.status === 'open' && (!task.assignee_openid || task.assignee_openid === me)
  if (!isTaker && !canTake) {
    throw errors.forbidden('只能查看自己领取的、或面向你开放的采购任务')
  }
}

/**
 * 发布采购任务
 * 入参：{ items:[{material_id, quantity, remark}], warehouse_id, assignee_openid, remark }
 */
async function create(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const rawItems = data.items
  if (!Array.isArray(rawItems) || !rawItems.length) return fail(400, '请至少添加一项要采购的物料')

  const remark = String(data.remark || '')
  const assigneeOpenid = String(data.assignee_openid || '').trim()

  let requestedWid = null
  if (data.warehouse_id !== undefined && data.warehouse_id !== null && data.warehouse_id !== '') {
    requestedWid = await resolveWarehouseId(data.warehouse_id)
    if (!requestedWid) return fail(400, '所选仓库不存在')
    ctx.requireWarehouseAccess(requestedWid, '采购任务')
  }

  const operator = operatorOf(ctx.user)

  // 幂等快速路径
  if (ctx.clientRequestId) {
    const existed = await queryOne(
      'SELECT id, task_no FROM purchase_tasks WHERE client_request_id = ? LIMIT 1',
      [ctx.clientRequestId]
    )
    if (existed) {
      return ok(
        { _id: existed.id, task_no: existed.task_no, duplicated: true },
        `该采购任务已发布（单号 ${existed.task_no}），请勿重复操作`
      )
    }
  }

  // 指定人必须是启用中的采购员，否则任务会挂在一个没人能领的状态上
  let assigneeName = null
  if (assigneeOpenid) {
    const u = await queryOne(
      'SELECT real_name, nickname, status, roles FROM users WHERE openid = ? LIMIT 1',
      [assigneeOpenid]
    )
    if (!u) return fail(400, '指定的采购员不存在')
    const roles = parseRoles(u.roles)
    if (!roles.includes('purchase')) return fail(400, '只能指定「采购员」岗位的人来采购')
    if (u.status !== 'active') return fail(400, '该采购员账号未启用，不能指派')
    assigneeName = u.real_name || u.nickname || ''
  }

  const run = async (attempt) => {
    try {
      return await withTransaction(async (conn) => {
        const ids = rawItems.map((it) => toDbId(it.material_id)).filter(Boolean)
        if (ids.length !== rawItems.length) throw errors.badRequest('采购项缺少有效的物料 ID')

        const matMap = await lockMaterialsSorted(conn, ids)

        // 任务必须同仓（与出入库单一致：一张单一个仓库）
        const wids = new Set()
        for (const it of rawItems) {
          const m = matMap.get(toDbId(it.material_id))
          if (!m) throw errors.badRequest(`物料不存在或已删除（id=${it.material_id}）`)
          wids.add(Number(m.warehouse_id))
        }
        if (wids.size > 1) {
          throw errors.badRequest(
            `一张采购任务不能包含多个仓库的物料（当前混了仓库 ${[...wids].join('、')}）。请分开创建`
          )
        }
        const wid = [...wids][0]
        if (requestedWid && requestedWid !== wid) {
          throw errors.badRequest('所选仓库与物料的实际所属仓库不一致，请刷新后重试')
        }
        ctx.requireWarehouseAccess(wid, '采购任务')

        // 采购任务只针对配件仓（2026-10-12）：成品仓存的是成品（车间入库），不需要采购。
        // 校验放在物料锁完之后（wid 已确定），在事务里读仓库表没风险。
        const wh = await queryOne('SELECT code, name FROM warehouses WHERE id = ? AND is_deleted = 0', [wid], conn)
        if (!wh || !isPartsWarehouse(wh.code)) {
          throw errors.badRequest(`采购任务只针对配件仓；「${wh ? wh.name : '所选仓库'}」是成品仓，成品不需要采购`)
        }

        const taskNo = await nextOrderNo(conn, 'purchase')

        const mainRes = await execute(
          `INSERT INTO purchase_tasks
             (task_no, warehouse_id, status, creator_openid, creator_name,
              assignee_openid, assignee_name, remark, client_request_id, is_deleted, created_at, updated_at)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
          [
            taskNo, wid, operator.openid, operator.name,
            assigneeOpenid || null, assigneeName || null, remark, ctx.clientRequestId || null
          ],
          conn
        )
        const taskId = mainRes.insertId

        for (const it of rawItems) {
          const mid = toDbId(it.material_id)
          const m = matMap.get(mid)
          const name = m.name
          const quantity = positiveInt(it.quantity, `「${name}」的采购数量`)
          await execute(
            `INSERT INTO purchase_task_items
               (task_id, material_id, material_name, material_spec, unit, quantity, unit_price, remark)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
            [taskId, mid, name, m.spec || '', m.unit || '', quantity, String(it.remark || '')],
            conn
          )
        }

        await writeOpLog(conn, {
          openid: operator.openid, userName: operator.name,
          role: (ctx.user.roles || []).join(','),
          action: 'purchase_task_create', targetId: taskId,
          detail: `发布采购任务 ${taskNo}，共 ${rawItems.length} 项${assigneeName ? '，指定给 ' + assigneeName : ''}`,
          ip: ctx.ip
        })

        // 通知采购员：指定了人只发给他，没指定就广播给全体采购员
        const content = `${operator.name} 发布了采购任务 ${taskNo}（${rawItems.length} 项），请及时领取`
        if (assigneeOpenid) {
          await pushMessage({
            toOpenids: [assigneeOpenid],
            type: MSG_TYPE.PURCHASE_TASK_ASSIGNED,
            title: '你有一项新的采购任务',
            content,
            refType: 'purchase_task', refId: taskId, refNo: taskNo
          }, conn)
        } else {
          await pushMessage({
            toRoles: ['purchase'],
            type: MSG_TYPE.PURCHASE_TASK_OPEN,
            title: '有新的采购任务可领取',
            content,
            refType: 'purchase_task', refId: taskId, refNo: taskNo
          }, conn)
        }

        return { taskId, taskNo }
      })
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        if (ctx.clientRequestId) {
          const existed = await queryOne(
            'SELECT id, task_no FROM purchase_tasks WHERE client_request_id = ? LIMIT 1',
            [ctx.clientRequestId]
          )
          if (existed) return { taskId: existed.id, taskNo: existed.task_no, duplicated: true }
        }
        if (attempt < 3) return run(attempt + 1)
      }
      throw err
    }
  }

  const r = await run(0)
  if (r.duplicated) {
    return ok({ _id: r.taskId, task_no: r.taskNo, duplicated: true }, `该采购任务已发布（单号 ${r.taskNo}）`)
  }
  return ok({ _id: r.taskId, task_no: r.taskNo }, '采购任务已发布，已通知采购员')
}

/** 解析 users.roles（JSON 数组，兼容字符串） */
function parseRoles(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch (e) {
    return []
  }
}

/** 采购任务列表 */
async function list(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const { page, pageSize, offset } = paging(data, data.forExport ? 2000 : 50)
  const { status, warehouse_id: warehouseId, keyword } = data
  const me = identityOf(ctx.user)

  // 采购任务只针对配件仓（2026-10-12）：成品仓任务不该出现在任何角色的列表里
  const where = ['t.is_deleted = 0', PARTS_SCOPE_SQL]
  const params = []

  const isManager = hasAnyRole(ctx.user, ['boss', 'admin'])
  const isStorekeeper = hasAnyRole(ctx.user, ['storekeeper'])
  const isPurchase = hasAnyRole(ctx.user, ['purchase'])

  if (!isManager && !isStorekeeper) {
    if (!isPurchase) {
      // 其他角色（如领料员）看不到采购任务
      return ok({ list: [], total: 0, page, pageSize })
    }
    // 采购员：自己领的 + 面向自己开放可领的
    where.push("(t.taker_openid = ? OR (t.status = 'open' AND (t.assignee_openid IS NULL OR t.assignee_openid = '' OR t.assignee_openid = ?)))")
    params.push(me, me)
  } else {
    // 仓管/老板：按可管仓库收敛
    const scope = ctx.warehouseScope('t', warehouseId)
    if (scope.sql) {
      where.push(scope.sql.replace(/^AND\s+/, ''))
      params.push(...scope.params)
    }
  }

  if (status) {
    where.push('t.status = ?')
    params.push(String(status))
  }
  if (keyword && String(keyword).trim()) {
    where.push('(t.task_no LIKE ? OR t.creator_name LIKE ? OR t.taker_name LIKE ?)')
    const kw = `%${String(keyword).trim()}%`
    params.push(kw, kw, kw)
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM purchase_tasks t WHERE ${whereSql}`, params)
  const tasks = await query(
    `SELECT t.*, w.name AS warehouse_name
       FROM purchase_tasks t
       LEFT JOIN warehouses w ON w.id = t.warehouse_id
      WHERE ${whereSql}
      ORDER BY FIELD(t.status, 'open', 'taken', 'purchased', 'received', 'cancelled'), t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  if (tasks.length) {
    const ids = tasks.map((t) => t.id)
    const itemRows = await query(
      `SELECT * FROM purchase_task_items WHERE task_id IN (${ids.map(() => '?').join(',')})`,
      ids
    )
    const grouped = {}
    for (const it of itemRows) {
      if (!grouped[it.task_id]) grouped[it.task_id] = []
      grouped[it.task_id].push(it)
    }
    const meForFlag = me
    for (const t of tasks) {
      t.items = grouped[t.id] || []
      t.status_text = statusText(t.status)
      t.is_mine = t.taker_openid === meForFlag
      t.can_take = t.status === 'open' && (!t.assignee_openid || t.assignee_openid === meForFlag)
      t.item_count = t.items.length
      t.material_names = t.items.map((i) => i.material_name).filter(Boolean).join('、')
      // 仓管不看金额（2026-10-10）：采购任务的预算金额 + 明细单价（采购员自己不受影响）
      if (isCostHiddenUser(ctx.user)) {
        delete t.total_amount
        for (const it of t.items) delete it.unit_price
      }
    }
  }

  return ok({ list: toApi(tasks), total: cnt.total, page, pageSize })
}

/** 任务详情 */
async function detail(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '任务 ID 无效')

  const task = await queryOne(
    `SELECT t.*, w.name AS warehouse_name
       FROM purchase_tasks t
       LEFT JOIN warehouses w ON w.id = t.warehouse_id
      WHERE t.id = ? AND t.is_deleted = 0`,
    [id]
  )
  if (!task) return fail(404, '采购任务不存在')

  assertTaskVisible(ctx, task)

  const items = await query('SELECT * FROM purchase_task_items WHERE task_id = ? ORDER BY id', [id])
  // 明细也要过 toApi：主键转 _id（前端逐项确认/收料清单都按 _id 取）
  task.items = toApi(items)
  task.status_text = statusText(task.status)
  task.is_mine = task.taker_openid === identityOf(ctx.user)
  task.can_take = task.status === 'open' && (!task.assignee_openid || task.assignee_openid === identityOf(ctx.user))

  // 到货即入库后，一张任务会对应多张入库单（每批到货一张），列表要能看全
  task.inbound_orders = items.length
    ? await query(
        `SELECT o.id, o.order_no, o.status, o.total_price, o.created_at, o.source_item_id,
                oi.quantity, oi.unit_price, oi.material_name
           FROM inbound_orders o
           JOIN inbound_order_items oi ON oi.order_id = o.id
          WHERE o.source_item_id IN (${items.map(() => '?').join(',')})
          ORDER BY o.id`,
        items.map((it) => it.id))
    : []

  // 仓管不看金额（2026-10-10）：任务预算金额、明细单价、关联入库单的金额都不下发
  if (isCostHiddenUser(ctx.user)) {
    delete task.total_amount
    for (const it of task.items || []) delete it.unit_price
    for (const o of task.inbound_orders || []) { delete o.total_price; delete o.unit_price }
  }

  return ok(toApi(task))
}

/** 领取采购任务（采购员） */
async function take(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '任务 ID 无效')

  const task = await queryOne('SELECT * FROM purchase_tasks WHERE id = ? AND is_deleted = 0', [id])
  if (!task) return fail(404, '采购任务不存在')

  const me = identityOf(ctx.user)
  const operator = operatorOf(ctx.user)

  if (task.status === 'taken' && task.taker_openid === me) {
    return ok({ duplicated: true }, '你已经领取过这项任务，请继续采购录入')
  }
  if (task.status !== 'open') {
    return fail(400, `该任务当前状态「${statusText(task.status)}」，不能领取`)
  }
  // 指定给别人的任务，别人不能抢
  if (task.assignee_openid && task.assignee_openid !== me) {
    return fail(403, `该任务已指定给「${task.assignee_name || '其他采购员'}」，你无法领取`)
  }

  // 条件更新：并发抢单只有一个能成功
  const res = await execute(
    `UPDATE purchase_tasks
        SET status = 'taken', taker_openid = ?, taker_name = ?, taken_at = NOW()
      WHERE id = ? AND status = 'open'`,
    [operator.openid, operator.name, id]
  )

  if (!res.affectedRows) {
    return fail(409, '该任务刚刚已被其他采购员领取')
  }

  await writeOpLog(null, {
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'purchase_task_take', targetId: id,
    detail: `领取采购任务 ${task.task_no}`, ip: ctx.ip
  })

  return ok({ status: 'taken' }, '领取成功，请尽快采购并录入')
}

/**
 * 采购录入（采购员）：实际单价 / 购买方式 / 淘宝单号 / 单据附件
 * 入参：{ id, items:[{_id?, material_id, unit_price}], purchase_channel, external_no, receipt_fileid, remark }
 */
async function entry(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '任务 ID 无效')

  const task = await queryOne('SELECT * FROM purchase_tasks WHERE id = ? AND is_deleted = 0', [id])
  if (!task) return fail(404, '采购任务不存在')

  const me = identityOf(ctx.user)
  if (task.taker_openid !== me && !hasAnyRole(ctx.user, ['boss', 'admin'])) {
    return fail(403, '只有该任务的领取人可以录入采购信息')
  }
  if (task.status === 'purchased') {
    return fail(400, '该任务已提交采购信息，等待仓管收料，请勿重复录入')
  }
  if (task.status !== 'taken') {
    return fail(400, `该任务当前状态「${statusText(task.status)}」，不能录入采购信息`)
  }

  const channel = String(data.purchase_channel || '').trim()
  if (channel && !PURCHASE_CHANNELS.includes(channel)) {
    return fail(400, `购买方式只能是：${PURCHASE_CHANNELS.join(' / ')}`)
  }

  const externalNo = String(data.external_no || '').trim()
  const receiptFileid = String(data.receipt_fileid || '').trim()

  // 建单备注不能被采购录入覆盖（V3 测试 P1-5）
  // 仓管建单时写的是「为什么要买这个」，采购员录入时写的是「在哪买的、怎么买的」，
  // 两条信息都要留住。原实现直接 `remark = ?` 把建单备注整条冲掉且没有任何提示。
  // 这里不新增字段（避免动 schema），改为追加；超长按字段上限截断。
  const entryRemark = String(data.remark || '').trim()
  const baseRemark = String(task.remark || '').trim()
  const remark = (entryRemark
    ? (baseRemark ? `${baseRemark} ／ 采购备注：${entryRemark}` : entryRemark)
    : baseRemark
  ).slice(0, 255)

  // 明细：单价 + 购买方式 + 外部单号都按行记（V4 需求：一张单里不同物料可能从不同地方买）
  // 兼容旧客户端：明细没填渠道时回落到整单的 purchase_channel
  const dbItems = await query('SELECT * FROM purchase_task_items WHERE task_id = ? ORDER BY id', [id])
  const itemPatch = new Map()
  if (Array.isArray(data.items)) {
    for (const it of data.items) {
      const mid = toDbId(it.material_id)
      if (!mid) continue
      const p = num(it.unit_price)
      // 单价必须大于 0：填 0 或漏填会让这批货的入库成本变成 0，库存账就废了
      if (!(p > 0)) return fail(400, '每一项的实际单价都必须大于 0（采购成本要按它计算）')
      const ic = String(it.purchase_channel || '').trim() || channel
      if (!ic) return fail(400, '每一项都要选购买方式（不同物料可能从不同地方买）')
      if (!PURCHASE_CHANNELS.includes(ic)) {
        return fail(400, `购买方式只能是：${PURCHASE_CHANNELS.join(' / ')}`)
      }
      itemPatch.set(mid, {
        price: p,
        channel: ic,
        // 「其他」的补充说明按明细记（一张单里可能一项走 1688、一项走「其他」）
        channelRemark: String(it.channel_remark || '').trim().slice(0, 255),
        externalNo: String(it.external_no || '').trim() || (channel ? externalNo : '')
      })
    }
  }

  // 每项都必须有单价：没有单价的采购单交回仓管后无法入库（加权成本要按单价算）
  for (const it of dbItems) {
    const patch = itemPatch.get(Number(it.material_id))
    if (!patch) {
      return fail(400, `请填写「${it.material_name}」的实际单价`)
    }
    // 选了「其他」就必须写清楚到底是哪个渠道，否则账上只剩「其他」两个字，
    // 对账时查不出这批货从哪来（前端也做了必填校验，这里是服务端兜底）
    if (patch.channel === OTHER_CHANNEL && !patch.channelRemark) {
      return fail(400, `「${it.material_name}」的购买方式选了「其他」，请补充说明具体从哪里买的`)
    }
  }

  const operator = operatorOf(ctx.user)

  // 整单渠道/单号 = 各项的去重拼接（明细级才是准的，任务级只用于列表展示）
  // 「其他」把说明带上，否则列表里一排「其他」根本看不出货从哪买的
  const channelLabel = (v) => (v.channel === OTHER_CHANNEL && v.channelRemark
    ? `${v.channel}（${v.channelRemark}）`
    : v.channel)
  const channelsUsed = [...new Set([...itemPatch.values()].map(channelLabel))]
  const extNosUsed = [...new Set([...itemPatch.values()].map((v) => v.externalNo).filter(Boolean))]
  // ⚠️ 这两个字段都是 varchar，本机 MySQL 开了 STRICT_TRANS_TABLES：
  //    写超长不是静默截断，而是报 1406 让整个提交失败。所以在这里主动截。
  const taskChannel = (channelsUsed.join(' / ') || channel).slice(0, 128)
  const taskExternalNo = (extNosUsed.join(' / ') || externalNo).slice(0, 255)

  await withTransaction(async (conn) => {
    let total = 0
    for (const it of dbItems) {
      const patch = itemPatch.get(Number(it.material_id))
      total += patch.price * num(it.quantity)
      await execute(
        'UPDATE purchase_task_items SET unit_price = ?, purchase_channel = ?, channel_remark = ?, external_no = ? WHERE id = ?',
        [patch.price, patch.channel, patch.channelRemark, patch.externalNo, it.id],
        conn
      )
    }

    const upd = await execute(
      `UPDATE purchase_tasks
          SET status = 'purchased', purchase_channel = ?, external_no = ?,
              receipt_fileid = ?, total_amount = ?, remark = ?, purchased_at = NOW(), reject_reason = NULL
        WHERE id = ? AND status = 'taken'`,
      [taskChannel, taskExternalNo, receiptFileid, money(total), remark, id],
      conn
    )
    if (!upd.affectedRows) {
      throw errors.biz('该任务状态已变化，请刷新后重试')
    }

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      role: (ctx.user.roles || []).join(','),
      action: 'purchase_task_entry', targetId: id,
      detail: `提交采购信息 ${task.task_no}，购买方式 ${taskChannel}，金额 ${money(total)}`, ip: ctx.ip
    })

    // 通知仓管来收料
    await notifyStorekeepers(conn, task.warehouse_id, {
      type: MSG_TYPE.PURCHASE_DONE,
      title: '采购已完成，等待收料入库',
      content: `${operator.name} 已完成采购 ${task.task_no}（${channel}），金额 ${money(total)}，请核对实物后收货入库`,
      refType: 'purchase_task', refId: id, refNo: task.task_no
    })
  })

  return ok({ status: 'purchased' }, '已提交，等待仓管收货入库')
}

/**
 * 把某条采购明细的「已入账数量」同步到 targetQty —— 到货即入库的核心
 * ⚠️ 必须在事务内调用（conn）。到货、办结、退回都靠它，库存只在这里动。
 *
 * 差额口径：delta = targetQty − 该明细已入账数量(stocked_qty)
 *   delta > 0 → 生成一张入库单 + addForInbound 加库存（每批到货一张单，正好对应一批货）
 *   delta < 0 → 上次报多了：把最近一张自己的入库单**整张作废**冲回，直到不再超；
 *               再按余下的差额补一张新的（不做部分冲减，避免入库单与实际库存对不上）
 *   delta = 0 → 什么都不动（同一数量重复提交天然幂等）
 *
 * @returns {Promise<Array<{order_no:string, action:'created'|'cancelled', quantity:number}>>}
 */
async function syncItemStock(conn, { task, item, targetQty, operator }) {
  const matMap = await lockMaterialsSorted(conn, [Number(item.material_id)])
  const material = matMap.get(Number(item.material_id))
  if (!material) throw errors.badRequest(`物料不存在或已删除（${item.material_name}）`)

  const price = num(item.unit_price)
  if (!(price > 0)) {
    throw errors.biz(`「${item.material_name}」缺采购单价，无法入库，请退回给采购员补录`)
  }

  const touched = []
  let delta = money(num(targetQty) - num(item.stocked_qty))

  // 1) 先把「报多了」的部分冲回
  while (delta < 0) {
    const last = await queryOne(
      `SELECT o.id, o.order_no, oi.quantity, oi.unit_price
         FROM inbound_orders o
         JOIN inbound_order_items oi ON oi.order_id = o.id
        WHERE o.source_item_id = ? AND o.status = 'confirmed' AND o.is_deleted = 0
        ORDER BY o.id DESC LIMIT 1`,
      [item.id], conn
    )
    if (!last) {
      throw errors.biz(
        `「${item.material_name}」已入账数量与入库单对不上（差 ${Math.abs(delta)}），` +
        `请到「库存盘点」调整或联系管理员`
      )
    }

    const lastQty = num(last.quantity)
    // 冲回会把库存扣成负数 → 说明这批货已经被领用了，不能硬冲
    const after = qty(num(material.current_stock) - lastQty)
    if (after < 0) {
      throw errors.biz(
        `无法把「${item.material_name}」的到货数改小：这批货已被领用，` +
        `当前库存 ${material.current_stock}、冲回需扣 ${lastQty}。请改用盘点调整`
      )
    }

    await restoreForInboundCancel(conn, {
      material, quantity: lastQty, unitPrice: num(last.unit_price),
      orderNo: last.order_no, operator,
      remark: `采购任务 ${task.task_no} 到货数改小，冲回`
    })
    await execute(
      `UPDATE inbound_orders
          SET status = 'cancelled', cancelled_at = NOW(),
              cancel_operator_openid = ?, cancel_operator_name = ?, cancel_reason = ?
        WHERE id = ?`,
      [operator.openid, operator.name, `到货数量修正（改小 ${lastQty}）`, last.id], conn
    )
    touched.push({ order_no: last.order_no, action: 'cancelled', quantity: lastQty })
    delta = money(delta + lastQty)
  }

  // 2) 再把欠的补上：一张入库单 + 加库存
  if (delta > 0) {
    const orderNo = await nextOrderNo(conn, 'inbound')
    const amount = money(price * delta)
    const mainRes = await execute(
      `INSERT INTO inbound_orders
         (order_no, warehouse_id, type, source_item_id, supplier, supplier_id, total_price,
          operator_openid, operator_name, remark, status,
          confirm_operator_openid, confirm_operator_name, confirmed_at,
          is_deleted, created_at, updated_at)
       VALUES (?, ?, 'purchase', ?, ?, NULL, ?, ?, ?, ?, 'confirmed', ?, ?, NOW(), 0, NOW(), NOW())`,
      [
        orderNo, task.warehouse_id, item.id,
        item.purchase_channel || task.purchase_channel || '', amount,
        operator.openid, operator.name,
        `采购任务 ${task.task_no} 到货入库（${item.material_name}）`,
        operator.openid, operator.name
      ],
      conn
    )

    await addForInbound(conn, {
      material, quantity: delta, unitPrice: price,
      orderNo, operator, remark: `采购到货（任务 ${task.task_no}）`
    })

    await execute(
      `INSERT INTO inbound_order_items
         (order_id, material_id, material_name, material_spec, quantity, unit, unit_price, total_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [mainRes.insertId, item.material_id, material.name, material.spec || '',
       delta, material.unit || '', price, amount],
      conn
    )
    touched.push({ order_no: orderNo, action: 'created', quantity: delta })
  }

  return touched
}

/**
 * 逐项到货登记（仓管）：一张单多个货件不同时到，实到数量可分次累加
 * 入参：{ id, item_id, action: 'receive'|'return', received_qty?, return_reason? }
 * 规则：
 *   - 任务状态须为 待收料(purchased)/收货中(receiving)
 *   - **到货 = 入库**：填的实到数量（>0 且 ≤ 采购数量）当场写进库存，不用再点「入库」；
 *     分次到货就改大它，系统按差额补库存；报多了改小则自动冲回
 *     到齐（=采购数）→ received；没到齐 → partial
 *   - 退货：剩余部分不要了（已到的部分已经入账，不动）；全退则该项不入库
 *   - 办结要求每项都「到齐 或 退货」，只登记了一部分不行
 */
async function receiveItem(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const itemId = toDbId(data.item_id)
  if (!id || !itemId) return fail(400, '任务或明细 ID 无效')

  const task = await queryOne('SELECT * FROM purchase_tasks WHERE id = ? AND is_deleted = 0', [id])
  if (!task) return fail(404, '采购任务不存在')
  ctx.requireWarehouseAccess(task.warehouse_id, '该采购任务')

  if (task.status === 'received') {
    return fail(400, '该任务已整单入库，不能再改到货数量')
  }
  if (!['purchased', 'receiving'].includes(task.status)) {
    return fail(400, `当前状态「${statusText(task.status)}」不能登记到货（需采购员先提交采购信息）`)
  }

  const item = await queryOne('SELECT * FROM purchase_task_items WHERE id = ? AND task_id = ?', [itemId, id])
  if (!item) return fail(404, '明细项不存在')
  if (item.receive_status === 'stocked') {
    return fail(400, `「${item.material_name}」已入库，不能再改；要纠错请走盘点调整`)
  }

  const planned = num(item.quantity)
  const mode = String(data.action || '').trim()
  const operator = operatorOf(ctx.user)

  if (mode === 'receive') {
    const qty = num(data.received_qty)
    if (!(qty > 0)) return fail(400, '实到数量必须大于 0；一件没到请选「退货」')
    if (qty > planned) return fail(400, `实到 ${qty} 超过采购数量 ${planned}，请核对`)
    const newStatus = qty >= planned ? 'received' : 'partial'

    // ⚠️ 到货即入账：库存当场加上。分次到货按差额补；报多了改小则把对应入库单冲回
    let touched = []
    try {
      await withTransaction(async (conn) => {
        // 行锁 + 比对改前的 stocked_qty：挡住并发和重复提交
        // （比的是「改前值」，所以数量没变的重复提交不会被误判成并发）
        const locked = await queryOne(
          'SELECT * FROM purchase_task_items WHERE id = ? FOR UPDATE', [itemId], conn)
        if (!locked) throw errors.biz('该明细已不存在，请刷新后重试')
        if (num(locked.stocked_qty) !== num(item.stocked_qty)) {
          const e = errors.biz('这条明细刚刚被其他操作改过，请刷新后重试')
          e.__concurrent = true
          throw e
        }

        touched = await syncItemStock(conn, { task, item: locked, targetQty: qty, operator })

        await execute(
          `UPDATE purchase_task_items
              SET receive_status = ?, received_qty = ?, stocked_qty = ?, return_reason = ''
            WHERE id = ?`,
          [newStatus, qty, qty, itemId], conn
        )
        if (task.status === 'purchased') {
          await execute("UPDATE purchase_tasks SET status = 'receiving' WHERE id = ? AND status = 'purchased'", [id], conn)
        }

        const deltaText = touched.length
          ? '；' + touched.map((t) => (t.action === 'created'
              ? `入库单 ${t.order_no} +${t.quantity}`
              : `冲回 ${t.order_no} −${t.quantity}`)).join('，')
          : '（数量无变化，库存不动）'
        await writeOpLog(conn, {
          openid: operator.openid, userName: operator.name,
          role: (ctx.user.roles || []).join(','),
          action: 'purchase_item_receive', targetId: id,
          detail: `${task.task_no}「${item.material_name}」到货入库：实到 ${qty}/${planned}${newStatus === 'received' ? '（已到齐）' : ''}${deltaText}`,
          ip: ctx.ip
        })
      })
    } catch (err) {
      if (err && err.__concurrent) return fail(409, err.message)
      throw err
    }

    const added = touched.filter((t) => t.action === 'created').reduce((s, t) => s + num(t.quantity), 0)
    const backed = touched.filter((t) => t.action === 'cancelled').reduce((s, t) => s + num(t.quantity), 0)
    const stockMsg = added > 0 ? `，库存 +${added}` : (backed > 0 ? `，库存 −${backed}` : '')
    return ok(
      { receive_status: newStatus, received_qty: qty, stocked_qty: qty, inbound_orders: touched },
      newStatus === 'received'
        ? `「${item.material_name}」已到齐 ${qty}${stockMsg}`
        : `「${item.material_name}」实到 ${qty}/${planned}${stockMsg}，还差 ${planned - qty}`
    )
  }

  if (mode === 'return') {
    const arrived = num(item.received_qty)
    const returnQty = planned - arrived
    if (returnQty <= 0) return fail(400, '该项已登记到齐，没有可退的数量')
    const reason = String(data.return_reason || '').trim().slice(0, 255)
    await withTransaction(async (conn) => {
      // 退货 = 关闭该项（剩余不再等）；已到的 received_qty 保留，入库时按实到入
      await execute(
        `UPDATE purchase_task_items
            SET receive_status = 'returned', return_reason = ?
          WHERE id = ?`,
        [reason, itemId], conn
      )
      if (task.status === 'purchased') {
        await execute("UPDATE purchase_tasks SET status = 'receiving' WHERE id = ? AND status = 'purchased'", [id], conn)
      }
      await writeOpLog(conn, {
        openid: operator.openid, userName: operator.name,
        role: (ctx.user.roles || []).join(','),
        action: 'purchase_item_return', targetId: id,
        detail: `${task.task_no}「${item.material_name}」退货 ${returnQty}（实到 ${arrived} 入库）${reason ? '：' + reason : ''}`, ip: ctx.ip
      })
      // 通知采购员：这项有退货
      if (task.taker_openid) {
        await pushMessage({
          toOpenids: [task.taker_openid],
          type: MSG_TYPE.PURCHASE_RECEIVED,
          title: '采购任务有物料被退货',
          content: `${task.task_no} 的「${item.material_name}」被${operator.name}退货 ${returnQty} ${item.unit || ''}${reason ? '（' + reason + '）' : ''}${arrived > 0 ? `，实到 ${arrived} 正常入库` : '，该项不入库'}`,
          refType: 'purchase_task', refId: id, refNo: task.task_no
        }, conn)
      }
    })
    return ok({ receive_status: 'returned', received_qty: arrived }, `「${item.material_name}」已退货 ${returnQty} ${item.unit || ''}${arrived > 0 ? `（实到 ${arrived} 仍会入库）` : ''}`)
  }

  return fail(400, 'action 只能是 receive（到货）或 return（退货）')
}

/**
 * 单项入库（仓管）—— **已被「到货即入库」取代，保留仅作兼容**
 *
 * 2026-10-09 起，库存是在点「到货」时随实到数量一起写进去的，
 * 所以正常情况下调到这里时该项早就入过账 → 直接幂等返回。
 * 只有历史数据（到过货但没入账，stocked_qty < received_qty）才会真正补一张入库单。
 * 入参：{ id, item_id }
 */
async function stockItem(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const itemId = toDbId(data.item_id)
  if (!id || !itemId) return fail(400, '任务或明细 ID 无效')

  const task = await queryOne('SELECT * FROM purchase_tasks WHERE id = ? AND is_deleted = 0', [id])
  if (!task) return fail(404, '采购任务不存在')
  ctx.requireWarehouseAccess(task.warehouse_id, '该采购任务')

  const item = await queryOne('SELECT * FROM purchase_task_items WHERE id = ? AND task_id = ?', [itemId, id])
  if (!item) return fail(404, '明细项不存在')

  const received = num(item.received_qty)
  if (item.receive_status === 'stocked' || (num(item.stocked_qty) > 0 && num(item.stocked_qty) >= received)) {
    return ok({ duplicated: true }, `「${item.material_name}」已随到货入库，无需再单独入库`)
  }
  if (!(received > 0)) return fail(400, `「${item.material_name}」还没有到货，没有可入库的数量`)
  if (!['purchased', 'receiving'].includes(task.status)) {
    return fail(400, `当前状态「${statusText(task.status)}」不能入库`)
  }

  const operator = operatorOf(ctx.user)
  let touched = []
  try {
    await withTransaction(async (conn) => {
      const locked = await queryOne(
        'SELECT * FROM purchase_task_items WHERE id = ? FOR UPDATE', [itemId], conn)
      if (!locked) throw errors.biz('该明细已不存在，请刷新后重试')

      touched = await syncItemStock(conn, {
        task, item: locked, targetQty: num(locked.received_qty), operator
      })
      await execute('UPDATE purchase_task_items SET stocked_qty = received_qty WHERE id = ?', [itemId], conn)
    })
  } catch (err) {
    if (err && err.__concurrent) return ok({ duplicated: true }, '该项刚刚已入库，无需重复操作')
    throw err
  }

  const created = touched.filter((t) => t.action === 'created')
  if (!created.length) {
    return ok({ duplicated: true }, `「${item.material_name}」已随到货入库，无需再单独入库`)
  }
  return ok(
    { receive_status: item.receive_status, inbound_orders: created },
    `「${item.material_name}」已补入账 ${created.map((t) => t.quantity).join('、')} ${item.unit || ''}` +
    `（入库单 ${created.map((t) => t.order_no).join('、')}）`
  )
}

/**
 * 完成收货（仓管）：把任务办结
 *
 * ⚠️ 2026-10-09 改版：库存已经在点「到货」时逐项加过了，这里**不再动库存**，
 *    也不再生成「整单入库单」。它只负责：校验每项都处理完 → 任务置 received
 *    → 汇总本任务的入库单号 → 通知采购员。
 */
async function receive(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '任务 ID 无效')

  const task = await queryOne('SELECT * FROM purchase_tasks WHERE id = ? AND is_deleted = 0', [id])
  if (!task) return fail(404, '采购任务不存在')

  ctx.requireWarehouseAccess(task.warehouse_id, '该采购任务')

  if (task.status === 'received') {
    return ok(
      { duplicated: true, inbound_order_no: task.inbound_order_no },
      `该任务已办结（入库单 ${task.inbound_order_no || '—'}），无需重复操作`
    )
  }
  if (!['purchased', 'receiving'].includes(task.status)) {
    return fail(400, `只有「待收料/收货中」的任务可以完成收货（当前状态：${statusText(task.status)}）`)
  }

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM purchase_task_items WHERE task_id = ? ORDER BY id', [id])
  if (!items.length) return fail(400, '该任务没有明细，无法完成收货')

  const started = items.some((it) => it.receive_status && it.receive_status !== 'pending')
  if (!started) {
    return fail(400, '还没有登记任何到货：请先在明细里填实到数量点「到货」（点一下就会加库存）或走「退货」')
  }

  const notDone = items.filter((it) => !['received', 'returned', 'stocked'].includes(it.receive_status || 'pending'))
  if (notDone.length > 0) {
    const parts = notDone.map((it) => (it.receive_status === 'partial'
      ? `「${it.material_name}」实到 ${num(it.received_qty)}/${num(it.quantity)}（还差 ${num(it.quantity) - num(it.received_qty)}）`
      : `「${it.material_name}」未登记`))
    return fail(400, `还有 ${notDone.length} 项没有完成（${parts.join('、')}）。每项要到齐或退货后才能完成收货`)
  }

  // 本任务的入库单（到货时逐项生成的），用于汇总单号
  const orders = await query(
    `SELECT order_no FROM inbound_orders
      WHERE source_item_id IN (${items.map(() => '?').join(',')})
        AND status = 'confirmed' AND is_deleted = 0
      ORDER BY id`,
    items.map((it) => it.id))
  const orderNos = orders.map((o) => o.order_no)
  // ⚠️ purchase_tasks.inbound_order_no 只有 varchar(32)，分批多张单号塞不下（实测报 ER_DATA_TOO_LONG）
  //    → 这个字段只存首张，完整清单走 detail 返回的 inbound_orders
  const firstOrderNo = (orderNos[0] || '').slice(0, 32)
  // operation_logs.detail / messages.content 都是 varchar(512)，正文只列前 2 张
  const orderBrief = orderNos.length > 2
    ? `${orderNos.slice(0, 2).join('、')} 等 ${orderNos.length} 张`
    : orderNos.join('、')
  const stockedQtyTotal = items.reduce((s, it) => s + num(it.stocked_qty), 0)

  try {
    await withTransaction(async (conn) => {
      const upd = await execute(
        `UPDATE purchase_tasks
            SET status = 'received', received_at = NOW(), inbound_order_no = ?
          WHERE id = ? AND status IN ('purchased', 'receiving')`,
        [firstOrderNo, id],
        conn
      )
      if (!upd.affectedRows) {
        const e = errors.biz('该任务状态刚刚已变化，请刷新后重试')
        e.__concurrent = true
        throw e
      }

      // 办结后锁定明细：不能再改到货数量（要纠错请走盘点调整）
      await execute(
        `UPDATE purchase_task_items SET receive_status = 'stocked'
          WHERE task_id = ? AND receive_status IN ('received', 'returned')`,
        [id], conn
      )

      await writeOpLog(conn, {
        openid: operator.openid, userName: operator.name,
        role: (ctx.user.roles || []).join(','),
        action: 'purchase_task_receive', targetId: id,
        detail: stockedQtyTotal > 0
          ? `采购任务 ${task.task_no} 收货完成，累计入库 ${stockedQtyTotal}${orderBrief ? `，入库单 ${orderBrief}` : ''}`
          : `采购任务 ${task.task_no} 全部退货，收货完成（未入库）`,
        ip: ctx.ip
      })

      if (task.taker_openid) {
        await pushMessage({
          toOpenids: [task.taker_openid],
          type: MSG_TYPE.PURCHASE_RECEIVED,
          title: stockedQtyTotal > 0 ? '你的采购任务已完成收货' : '你的采购任务已办结（全部退货）',
          content: stockedQtyTotal > 0
            ? `${task.task_no} 已由${operator.name}完成收货，累计入库 ${stockedQtyTotal}${orderBrief ? `（入库单 ${orderBrief}）` : ''}，辛苦了`
            : `${task.task_no} 的所有货件均验收不合格已退货，任务办结、未入库`,
          refType: 'purchase_task', refId: id, refNo: task.task_no
        }, conn)
      }
    })
  } catch (err) {
    if (err && err.__concurrent) {
      const latest = await queryOne('SELECT * FROM purchase_tasks WHERE id = ?', [id])
      return ok(
        { duplicated: true, inbound_order_no: latest ? latest.inbound_order_no : '' },
        '该任务刚刚已被办结，无需重复操作'
      )
    }
    throw err
  }

  return ok(
    {
      status: 'received',
      inbound_order_no: orderBrief,
      inbound_order_count: orderNos.length,
      stocked_qty: stockedQtyTotal
    },
    stockedQtyTotal > 0
      ? `收货完成，累计入库 ${stockedQtyTotal}${orderBrief ? `（入库单 ${orderBrief}）` : ''}`
      : '全部货件已退货，任务办结（未入库）'
  )
}

/** 收料不通过：退回采购员补充（回到采购中） */
async function rejectBack(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const reason = String(data.reason || '').trim()
  if (!id) return fail(400, '任务 ID 无效')
  if (!reason) return fail(400, '请填写退回原因，采购员需要知道哪里不对')

  const task = await queryOne('SELECT * FROM purchase_tasks WHERE id = ? AND is_deleted = 0', [id])
  if (!task) return fail(404, '采购任务不存在')

  ctx.requireWarehouseAccess(task.warehouse_id, '该采购任务')

  if (!['purchased', 'receiving'].includes(task.status)) {
    return fail(400, `只有「待收料/收货中」的任务可以退回（当前状态：${statusText(task.status)}）`)
  }

  const operator = operatorOf(ctx.user)
  const items = await query('SELECT * FROM purchase_task_items WHERE task_id = ? ORDER BY id', [id])
  const stockedItems = items.filter((it) => num(it.stocked_qty) > 0)
  let backedQty = 0

  await withTransaction(async (conn) => {
    const upd = await execute(
      `UPDATE purchase_tasks
          SET status = 'taken', reject_reason = ?, purchased_at = NULL
        WHERE id = ? AND status IN ('purchased', 'receiving')`,
      [reason, id],
      conn
    )
    if (!upd.affectedRows) throw errors.biz('该任务状态已变化，请刷新后重试')

    // ⚠️ 2026-10-09 改版：到货时库存已经加上去了，退回必须把它冲回来，
    //    否则退回重采后库存会凭空多出一批（幽灵库存）。
    //    冲回会把库存扣成负数时（货已被领用）syncItemStock 会直接报错，让仓管先处理。
    for (const it of stockedItems) {
      const touched = await syncItemStock(conn, { task, item: it, targetQty: 0, operator })
      backedQty += touched
        .filter((t) => t.action === 'cancelled')
        .reduce((s, t) => s + num(t.quantity), 0)
    }

    // 退回重采：逐项到货确认清零（重新采购后重新收货）
    await execute(
      `UPDATE purchase_task_items
          SET receive_status = 'pending', received_qty = 0, stocked_qty = 0, return_reason = ''
        WHERE task_id = ?`,
      [id],
      conn
    )

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      role: (ctx.user.roles || []).join(','),
      action: 'purchase_task_reject', targetId: id,
      detail: `采购任务 ${task.task_no} 收料退回，原因：${reason}` +
        (backedQty > 0 ? `；已冲回库存 ${backedQty}` : ''), ip: ctx.ip
    })

    if (task.taker_openid) {
      await pushMessage({
        toOpenids: [task.taker_openid],
        type: MSG_TYPE.PURCHASE_DONE,
        title: '你的采购信息被退回',
        content: `${task.task_no} 被退回：${reason}。请修改后重新提交`,
        refType: 'purchase_task', refId: id, refNo: task.task_no
      }, conn)
    }
  })

  return ok({ status: 'taken' }, '已退回采购员，请他补充后重新提交')
}

/** 取消任务（仓管 / 老板 / 管理员） */
async function cancel(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  const reason = String(data.reason || '')
  if (!id) return fail(400, '任务 ID 无效')

  const task = await queryOne('SELECT * FROM purchase_tasks WHERE id = ? AND is_deleted = 0', [id])
  if (!task) return fail(404, '采购任务不存在')

  ctx.requireWarehouseAccess(task.warehouse_id, '该采购任务')

  if (task.status === 'cancelled') return fail(400, '该任务已取消')
  if (task.status === 'received') return fail(400, '该任务已收料入库，不能取消')

  const operator = operatorOf(ctx.user)

  await withTransaction(async (conn) => {
    const upd = await execute(
      `UPDATE purchase_tasks
          SET status = 'cancelled', cancelled_at = NOW(),
              cancel_operator_name = ?, cancel_reason = ?
        WHERE id = ? AND status IN ('open','taken','purchased')`,
      [operator.name, reason || null, id],
      conn
    )
    if (!upd.affectedRows) throw errors.biz('该任务状态已变化，请刷新后重试')

    await writeOpLog(conn, {
      openid: operator.openid, userName: operator.name,
      role: (ctx.user.roles || []).join(','),
      action: 'purchase_task_cancel', targetId: id,
      detail: `取消采购任务 ${task.task_no}${reason ? '，原因：' + reason : ''}`, ip: ctx.ip
    })

    if (task.taker_openid) {
      await pushMessage({
        toOpenids: [task.taker_openid],
        type: MSG_TYPE.PURCHASE_DONE,
        title: '采购任务已取消',
        content: `${task.task_no} 已被${operator.name}取消${reason ? '：' + reason : ''}`,
        refType: 'purchase_task', refId: id, refNo: task.task_no
      }, conn)
    }
  })

  return ok(null, '已取消该采购任务')
}

/**
 * 采购员待办数：可领 + 采购中（首页红点用）
 * 返回 { can_take, in_progress, total }
 */
async function myTodoCount(ctx) {
  if (!ctx.user) return fail(401, '请先登录')
  const me = identityOf(ctx.user)

  // 仓管的活不在「领取」而在「收料」：不给他算这一项，首页红点永远是 0，
  // 最该盯的一步（货到了等着入库）反而没人提醒。
  // 2026-10-09：口径从「待收料」扩到「未结单」= purchased（待收料）+ receiving（收货中）。
  //   新口径下「到货即入库」，一收货任务就进 receiving，货到一半、已入一部分账的
  //   任务同样是他没收完的活，只数 purchased 会让角标在收货中途归零。
  if (hasAnyRole(ctx.user, ['storekeeper']) && !hasAnyRole(ctx.user, ['purchase', 'boss', 'admin'])) {
    const scope = ctx.warehouseScope('t')
    const row = await queryOne(
      `SELECT
         SUM(t.status = 'purchased') AS waiting_receive,
         SUM(t.status = 'receiving') AS receiving
       FROM purchase_tasks t
       WHERE t.is_deleted = 0 AND ${PARTS_SCOPE_SQL} AND t.status IN ('purchased', 'receiving') ${scope.sql}`,
      scope.params
    )
    const waiting = num(row ? row.waiting_receive : 0)
    const receiving = num(row ? row.receiving : 0)
    const totalUnclosed = waiting + receiving
    return ok({
      can_take: 0,
      in_progress: totalUnclosed,
      waiting_receive: waiting,
      receiving,
      total: totalUnclosed
    })
  }

  if (!hasAnyRole(ctx.user, ['purchase', 'boss', 'admin'])) {
    return ok({ can_take: 0, in_progress: 0, total: 0 })
  }

  const row = await queryOne(
    `SELECT
       SUM(status = 'open' AND (assignee_openid IS NULL OR assignee_openid = '' OR assignee_openid = ?)) AS can_take,
       SUM(status IN ('taken','purchased') AND taker_openid = ?) AS in_progress
     FROM purchase_tasks
     WHERE is_deleted = 0 AND ${PARTS_SCOPE_SQL}`,
    [me, me]
  )

  const canTake = num(row ? row.can_take : 0)
  const inProgress = num(row ? row.in_progress : 0)
  return ok({ can_take: canTake, in_progress: inProgress, total: canTake + inProgress })
}

/** 可选的采购员列表（仓管发任务时指定用） */
async function assignees(ctx) {
  if (!ctx.user) return fail(401, '请先登录')

  const rows = await query(
    `SELECT openid, real_name, nickname
       FROM users
      WHERE status = 'active'
        AND openid IS NOT NULL AND openid <> ''
        AND JSON_CONTAINS(roles, JSON_QUOTE('purchase'))
      ORDER BY real_name, nickname`
  )

  return ok({
    list: toApi(rows.map((r) => ({
      openid: r.openid,
      name: r.real_name || r.nickname || r.openid
    })))
  })
}

module.exports = {
  name: 'purchase',
  publicActions: [],
  roleRules: {
    // 2026-10-09：老板只读，采购全链路动作收回 boss（发单归 仓管/厂长，买与收归 采购/仓管）
    create: ['storekeeper', 'admin', 'director'],
    take: ['purchase', 'admin'],
    entry: ['purchase', 'admin'],
    receive: ['storekeeper', 'admin'],
    receiveItem: ['storekeeper', 'admin'],
    stockItem: ['storekeeper', 'admin'],
    rejectBack: ['storekeeper', 'admin'],
    cancel: ['storekeeper', 'admin']
  },
  actions: {
    create, list, detail, take, entry, receive, receiveItem, stockItem, rejectBack, cancel,
    myTodoCount, assignees
  }
}
