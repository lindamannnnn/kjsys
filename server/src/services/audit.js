/**
 * ============================================================
 * 审计日志服务（统一出口）
 * ------------------------------------------------------------
 * 背景（V3 多岗位测试）：
 *   P1-8 有人反复尝试越权、被 403 拦下，**日志里完全看不出来**（6 次 403 → 日志 +0）
 *   P1-9 主数据（物料档案、仓库、供应商、用户资料）的修改**完全不写日志**，
 *        出了事查不到是谁改的
 *
 * 原来的问题是「谁需要日志谁自己写一条 INSERT」，
 * 于是 user.js / outbound.js / check.js / inbound.js / purchase.js 各写一份，
 * 新加的模块（material / warehouse / supplier）就漏了。
 * 现在统一走本文件，字段一次写全（含 result / fail_reason）。
 *
 * 约定：
 *   - 业务成功写入：result = 'success'
 *   - 被权限拦下的尝试：result = 'denied'，action = 'permission_denied'
 *   - 登录失败等：result = 'fail'
 *   - **日志写失败绝不影响主流程**（内部 try/catch，只打印到控制台）
 * ============================================================
 */
const { execute } = require('../db/pool')

/** 权限被拒时统一使用的 action 码（便于按它筛「谁在试越权」） */
const DENIED_ACTION = 'permission_denied'
/** 未登录/登录态失效时使用的 action 码 */
const AUTH_REQUIRED_ACTION = 'auth_required'

/**
 * 写一条审计日志
 * @param {object} p
 * @param {string} p.action      动作码，如 material_upsert / permission_denied
 * @param {string} [p.openid]    操作者身份（openid 或 username 兜底）
 * @param {string} [p.userName]  操作者姓名
 * @param {string} [p.role]      操作时角色
 * @param {string} [p.targetType] 目标类型：order / material / user / api …
 * @param {string|number} [p.targetId]
 * @param {string} [p.detail]    给人看的说明（写清「谁对什么做了什么」）
 * @param {string} [p.result]    success | denied | fail
 * @param {string} [p.failReason]
 * @param {string} [p.ip]
 * @param {object} [conn]        事务连接（与业务同事务写入）
 */
async function auditLog(p = {}, conn = null) {
  try {
    await execute(
      `INSERT INTO operation_logs
         (openid, user_name, role, action, target_type, target_id, detail, result, fail_reason, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        p.openid || '',
        p.userName || '',
        p.role || '',
        p.action || '',
        p.targetType || '',
        p.targetId === undefined || p.targetId === null ? '' : String(p.targetId),
        p.detail || '',
        p.result || 'success',
        p.failReason || '',
        p.ip || ''
      ],
      conn
    )
  } catch (e) {
    // 审计日志是「附带能力」，绝不能因为它写失败而让正常业务报错
    console.error('[审计日志写入失败]', e.message)
  }
}

/**
 * 从 ctx 取操作者信息后写日志（绝大多数业务模块用这个就好）
 * @param {object} ctx
 * @param {object} p  见 auditLog，无需再传 openid/userName/role/ip
 * @param {object} [conn]
 */
async function auditFromCtx(ctx, p = {}, conn = null) {
  const user = (ctx && ctx.user) || null
  const roles = (user && Array.isArray(user.roles) && user.roles) || []
  return auditLog(
    {
      openid: (user && (user.openid || user.username)) || '',
      userName: (user && (user.real_name || user.nickname || user.username)) || '未知用户',
      role: roles.join(','),
      ip: (ctx && ctx.ip) || '',
      ...p
    },
    conn
  )
}

/**
 * 记录一次「被拒绝的操作」
 *
 * 用途：有人反复试着越权（改别人权限、看别仓数据、伪造 token），
 * 这是唯一的线索来源。不记录的话，事后只能看到数据没被改，
 * 看不出「有人在试门」。
 */
function auditDenied({ ctx, moduleName, action, code, reason, ip }) {
  const user = (ctx && ctx.user) || null
  const who = user
    ? `${(user.real_name || user.nickname || user.username || '未知用户')}（${user.openid || user.username || ''}）`
    : '未登录'

  const detail =
    `尝试操作 ${moduleName}.${action} 被拒绝（${code}）：${reason || '无权限'}；操作者：${who}`

  // fire-and-forget：被拒的请求不该因为写日志而变慢，内部已做异常兜底
  auditLog({
    openid: (user && (user.openid || user.username)) || '',
    userName: (user && (user.real_name || user.nickname || user.username)) || (user ? '未知用户' : '未登录'),
    role: user && Array.isArray(user.roles) ? user.roles.join(',') : '',
    action: code === 401 ? AUTH_REQUIRED_ACTION : DENIED_ACTION,
    targetType: 'api',
    targetId: `${moduleName}.${action}`,
    detail,
    result: 'denied',
    failReason: String(reason || '').slice(0, 240),
    ip: ip || (ctx && ctx.ip) || ''
  })
}

module.exports = {
  auditLog,
  auditFromCtx,
  auditDenied,
  DENIED_ACTION,
  AUTH_REQUIRED_ACTION
}
