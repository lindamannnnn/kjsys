/**
 * 站内消息服务（流程重构 V2 · P1 消息中心）
 * ============================================================
 * 投递方式：按人写库（fan-out on write）
 *   发消息时就把「谁该收到」展开成一行行记录，好处是：
 *     - 「已读」状态天然按人隔离，不需要额外的已读关联表；
 *     - 列表查询只走 to_openid 索引，不必联表判角色。
 *   代价是按角色广播时会写多行 —— 本系统使用人数在十位数，可以忽略。
 *
 * 事务：所有函数都接受可选的 conn（事务连接）。
 *       业务状态变更与消息投递应当放在同一事务里，
 *       避免出现「单据状态已经改了、消息却没发出去」。
 * ============================================================
 */
const { query, execute } = require('../db/pool')
const wecom = require('./wecom')

/** 消息类型码（前端可据此决定点开后跳哪里） */
const MSG_TYPE = {
  OUTBOUND_SUBMITTED: 'outbound_submitted', // 领料员提交清单 → 通知仓管员
  OUTBOUND_PICKED: 'outbound_picked',       // 仓管拣货完成   → 通知领料员来收货
  OUTBOUND_REJECTED: 'outbound_rejected',   // 仓管驳回       → 通知领料员
  OUTBOUND_RECEIVED: 'outbound_received',   // 领料员确认收货 → 回执给仓管（可选）
  PURCHASE_TASK_ASSIGNED: 'purchase_task_assigned', // 仓管指派任务 → 通知该采购员
  PURCHASE_TASK_OPEN: 'purchase_task_open',         // 仓管发布任务 → 通知全体采购员
  PURCHASE_DONE: 'purchase_done',                   // 采购录入完成 → 通知仓管收料
  PURCHASE_RECEIVED: 'purchase_received',           // 仓管收料入库 → 通知采购员
  CHECK_PENDING_REVIEW: 'check_pending_review',     // 仓管提交盘点结果 → 通知老板/管理员审核
  CHECK_REJECTED: 'check_rejected',                 // 审核退回重盘     → 通知盘点人（带上退回原因）
  WARNING_NOTIFY: 'warning_notify'                  // 库存预警通知采购 → 通知采购员/仓管
}

/** 把角色展开为「启用中」账号的 openid 列表（去重） */
async function openidsByRoles(roles = [], conn = null) {
  const list = (roles || []).filter(Boolean)
  if (!list.length) return []

  // roles 是 JSON 数组，逐个 JSON_CONTAINS 取并集。
  // 这里不用 JSON_OVERLAPS，是为了兼容 MySQL 5.7（该函数 8.0 才有）。
  const conds = list.map(() => 'JSON_CONTAINS(roles, JSON_QUOTE(?))').join(' OR ')
  const rows = await query(
    `SELECT openid
       FROM users
      WHERE status = 'active'
        AND openid IS NOT NULL
        AND openid <> ''
        AND (${conds})`,
    list,
    conn
  )
  return rows.map((r) => r.openid)
}

/**
 * 按「角色 + 可管仓库」取 openid（去重）
 * 用途：通知到真正管这个仓的仓管，而不是全公司所有仓管都收到
 * （仓库没给或没人匹配时由调用方决定是否回退为全角色广播）
 * @param {string[]} roles
 * @param {number}   warehouseId
 */
async function openidsByWarehouseRoles(roles = [], warehouseId = null, conn = null) {
  const list = (roles || []).filter(Boolean)
  if (!list.length) return []
  if (!warehouseId) return openidsByRoles(list, conn)

  const conds = list.map(() => 'JSON_CONTAINS(roles, JSON_QUOTE(?))').join(' OR ')
  const rows = await query(
    `SELECT openid
       FROM users
      WHERE status = 'active'
        AND openid IS NOT NULL
        AND openid <> ''
        AND (${conds})
        AND JSON_VALID(warehouse_ids)
        AND JSON_CONTAINS(warehouse_ids, CAST(? AS JSON))`,
    [...list, String(warehouseId)],
    conn
  )
  return rows.map((r) => r.openid)
}

/**
 * 投递一条消息
 * @param {object} opt
 * @param {string[]} [opt.toOpenids] 指定接收人 openid
 * @param {string[]} [opt.toRoles]   按角色投递（自动展开为该角色下所有启用账号）
 * @param {string}   opt.type        类型码，见 MSG_TYPE
 * @param {string}   opt.title       标题（中文，界面直接展示）
 * @param {string}   [opt.content]   正文
 * @param {string}   [opt.refType]   关联单据类型，用于点击跳转
 * @param {number}   [opt.refId]     关联单据 id
 * @param {string}   [opt.refNo]     关联单号（冗余展示）
 * @param {object}   [conn]          事务连接（与业务写操作同事务）
 * @returns {number} 实际投递条数
 */
async function pushMessage(opt = {}, conn = null) {
  const {
    toOpenids = [],
    toRoles = [],
    type = '',
    title = '',
    content = '',
    refType = '',
    refId = null,
    refNo = ''
  } = opt

  // 没标题的消息在界面上毫无意义，直接不发
  if (!title) return 0

  const fromRoles = await openidsByRoles(toRoles, conn)
  const targets = Array.from(new Set([...toOpenids, ...fromRoles].filter(Boolean)))
  if (!targets.length) return 0

  // 一条 INSERT 写多行，减少往返
  const placeholders = targets.map(() => '(?,?,?,?,?,?,?,0)').join(',')
  const params = []
  for (const openid of targets) {
    params.push(
      openid,
      String(type || '').slice(0, 48),
      String(title).slice(0, 120),
      String(content || '').slice(0, 500),
      String(refType || '').slice(0, 32),
      refId || null,
      String(refNo || '').slice(0, 32)
    )
  }

  await execute(
    `INSERT INTO messages (to_openid, type, title, content, ref_type, ref_id, ref_no, is_read)
     VALUES ${placeholders}`,
    params,
    conn
  )

  // 企业微信同步推送（2026-10-14 投产新增）：
  //   站内信工人不会主动去刷，关键动作要同步推到企微。
  //   异步 fire-and-forget —— 不阻塞业务事务，推送失败也不影响站内信。
  //   没配置企微（wecom.isEnabled()=false）时这里直接跳过，站内信照发。
  if (wecom.isEnabled() && targets.length) {
    const text = `【${title}】${content || ''}`.trim()
    setImmediate(() => {
      pushWecomToOpenids(targets, text).catch((e) => console.warn('[企微] 异步推送失败：', e.message))
    })
  }

  return targets.length
}

/**
 * 把消息按 openid 推到对应员工的企业微信（只推给绑定了 wecom_userid 的）。
 * 内部函数，不在模块导出 —— 业务侧只调 pushMessage。
 */
async function pushWecomToOpenids(openids, text) {
  const ph = openids.map(() => '?').join(',')
  const rows = await query(
    `SELECT wecom_userid FROM users WHERE openid IN (${ph}) AND wecom_userid <> ''`,
    openids
  )
  const ids = rows.map((r) => r.wecom_userid).filter(Boolean)
  if (!ids.length) return { sent: 0 }
  return wecom.sendText(ids, text)
}

module.exports = { MSG_TYPE, pushMessage, openidsByRoles, openidsByWarehouseRoles }
