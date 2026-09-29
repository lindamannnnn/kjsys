/**
 * 用户管理模块（Web 后台专用）
 */
const bcrypt = require('bcryptjs')
const { query, queryOne, execute } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, toDbId, num, paging } = require('../utils/format')
const { operatorOf, isManagement, MANAGEMENT_ROLES, identityOf } = require('../middleware/auth')

const VALID_ROLES = ['out', 'in', 'purchase', 'storekeeper', 'boss', 'admin']

/**
 * 该用户是否是「系统里最后一个仍在启用状态的管理账号」
 *
 * ⚠️ 整改说明（P0-3.11）：原实现只拦「取消自己的 admin 权限」，
 *   boss 不在保护范围 → 老板 `updateRole {roles:["out"]}` 成功后被锁死，
 *   连改回来的接口都 403，只能靠 admin 默认密码才能救。
 *   现在：唯一的管理账号不能被降级、也不能被禁用。
 */
async function isLastActiveManager(user) {
  if (!user || !isManagement(user.roles)) return false
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM users
      WHERE status = 'active' AND id <> ?
        AND (JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('admin'))
          OR JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('boss')))`,
    [user.id]
  )
  return num(row.c) === 0
}

/** 角色数组里是否有管理角色（用于提示语） */
function roleHasManagement(roles) {
  return MANAGEMENT_ROLES.some((r) => (roles || []).includes(r))
}

async function writeOpLog(p) {
  try {
    await execute(
      `INSERT INTO operation_logs (openid, user_name, role, action, target_type, target_id, detail, result, ip, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, 'success', ?, NOW())`,
      [p.openid || '', p.userName || '', p.role || '', p.action || '', String(p.targetId || ''), p.detail || '', p.ip || '']
    )
  } catch (e) {
    console.error('[操作日志写入失败]', e.message)
  }
}

/** 用户列表 */
async function list(ctx, data = {}) {
  const { page, pageSize, offset } = paging(data)
  const { status, role, keyword } = data

  const where = ['1 = 1']
  const params = []

  if (status) {
    where.push('status = ?')
    params.push(String(status))
  }
  if (role) {
    where.push('JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE(?))')
    params.push(String(role))
  }
  if (keyword && String(keyword).trim()) {
    const kw = `%${String(keyword).trim()}%`
    where.push('(real_name LIKE ? OR phone LIKE ? OR nickname LIKE ? OR username LIKE ?)')
    params.push(kw, kw, kw, kw)
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM users WHERE ${whereSql}`, params)
  const rows = await query(
    `SELECT * FROM users WHERE ${whereSql} ORDER BY
       CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  return ok({ list: toApi(rows), total: cnt.total, page, pageSize })
}

/** 用户详情 */
async function detail(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '用户 ID 无效')

  const row = await queryOne('SELECT * FROM users WHERE id = ?', [id])
  if (!row) return fail(404, '用户不存在')

  // 单据表里 operator_openid 存的是「openid || username」兜底后的值（见 middleware/auth.js 的 operatorOf）。
  // 只按 row.openid 统计的话，用账号密码登录的账号（openid 为空）永远显示 0 单，
  // 老板查"这人干了多少活"会以为他在摸鱼。这里跟写入端用同一套标识。
  const who = identityOf(row)
  const stats = {
    outbound_orders: (await queryOne('SELECT COUNT(*) AS c FROM outbound_orders WHERE operator_openid = ?', [who]))?.c || 0,
    inbound_orders: (await queryOne('SELECT COUNT(*) AS c FROM inbound_orders WHERE operator_openid = ?', [who]))?.c || 0,
    checks: (await queryOne('SELECT COUNT(*) AS c FROM stock_checks WHERE operator_openid = ?', [who]))?.c || 0
  }

  const apiUser = toApi(row)
  apiUser.stats = stats
  return ok(apiUser)
}

/**
 * 审核通过并分配角色
 * 入参：{ id, roles:[], warehouse_ids:[] }
 */
async function approve(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  const roles = Array.isArray(data.roles) ? data.roles.filter((r) => VALID_ROLES.includes(r)) : []
  const warehouseIds = Array.isArray(data.warehouse_ids) ? data.warehouse_ids.map(Number).filter(Boolean) : []

  if (!id) return fail(400, '用户 ID 无效')
  if (!roles.length) return fail(400, '请至少分配一个角色')

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [id])
  if (!user) return fail(404, '用户不存在')

  if (!user.real_name) {
    return fail(400, '该用户尚未填写真实姓名，无法审核通过')
  }

  await execute(
    "UPDATE users SET roles = ?, warehouse_ids = ?, status = 'active' WHERE id = ?",
    [JSON.stringify(roles), JSON.stringify(warehouseIds), id]
  )

  const operator = operatorOf(ctx.user)
  await writeOpLog({
    openid: operator.openid, userName: operator.name, role: (ctx.user.roles || []).join(','),
    action: 'user_approve', targetId: id,
    detail: `审核通过用户「${user.real_name}」，角色：${roles.join('、')}`, ip: ctx.ip
  })

  return ok(null, `已通过审核，角色：${roles.join('、')}`)
}

/** 修改角色 */
async function updateRole(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  const roles = Array.isArray(data.roles) ? data.roles.filter((r) => VALID_ROLES.includes(r)) : null
  const warehouseIds = Array.isArray(data.warehouse_ids) ? data.warehouse_ids.map(Number).filter(Boolean) : null

  if (!id) return fail(400, '用户 ID 无效')
  if (roles && !roles.length) return fail(400, '角色不能为空')

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [id])
  if (!user) return fail(404, '用户不存在')

  // ---------- 防止把自己（或系统最后一个管理账号）锁在门外 ----------
  const nextRoles = roles || (Array.isArray(user.roles) ? user.roles : [])

  // 1) 不允许自己把自己从管理角色降级为普通员工
  if (id === ctx.user.id && isManagement(user.roles) && !roleHasManagement(nextRoles)) {
    return fail(
      400,
      '不能取消自己的管理权限（会把自己锁在系统外，将无法再改回来）。' +
      '如确实要调整，请让另一位管理员在「用户管理」里为你修改'
    )
  }

  // 2) 不允许摘掉系统里最后一个管理账号的权限
  if (!roleHasManagement(nextRoles) && (await isLastActiveManager(user))) {
    return fail(
      400,
      `不能再降低「${user.real_name || user.username}」的权限：` +
      `他/她当前是系统里唯一的管理账号，降级后将没有任何人能审批单据、调整账目和管理用户`
    )
  }

  const updates = []
  const params = []
  if (roles) {
    updates.push('roles = ?')
    params.push(JSON.stringify(roles))
  }
  if (warehouseIds) {
    updates.push('warehouse_ids = ?')
    params.push(JSON.stringify(warehouseIds))
  }
  if (!updates.length) return fail(400, '没有需要更新的内容')

  params.push(id)
  await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)

  const operator = operatorOf(ctx.user)
  const oldRoles = Array.isArray(user.roles) ? user.roles.join('、') : ''
  await writeOpLog({
    openid: operator.openid, userName: operator.name, action: 'user_update_role', targetId: id,
    detail:
      `修改用户「${user.real_name || user.nickname}」角色：${oldRoles || '（空）'} → ${(roles || []).join('、')}` +
      (warehouseIds ? `；可管仓库：${warehouseIds.join('、')}` : ''),
    ip: ctx.ip
  })

  return ok(null, '角色已更新')
}

/** 禁用 / 启用 */
async function setStatus(ctx, data = {}, status) {
  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '用户 ID 无效')

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [id])
  if (!user) return fail(404, '用户不存在')

  if (id === ctx.user.id) {
    return fail(400, `不能${status === 'disabled' ? '禁用' : '启用'}自己的账号`)
  }

  // 不允许禁用系统里最后一个管理账号（否则审批/改账全停摆）
  if (status === 'disabled' && (await isLastActiveManager(user))) {
    return fail(
      400,
      `不能禁用「${user.real_name || user.username}」：他/她当前是系统里唯一的管理账号，` +
      `禁用后将没有任何人能审批单据、调整账目和管理用户`
    )
  }

  await execute('UPDATE users SET status = ? WHERE id = ?', [status, id])

  const operator = operatorOf(ctx.user)
  await writeOpLog({
    openid: operator.openid, userName: operator.name,
    action: status === 'disabled' ? 'user_disable' : 'user_enable', targetId: id,
    detail: `${status === 'disabled' ? '禁用' : '启用'}用户「${user.real_name || user.nickname || user.username}」`,
    ip: ctx.ip
  })

  return ok(null, status === 'disabled' ? '已禁用该账号' : '已启用该账号')
}

const disable = (ctx, data) => setStatus(ctx, data, 'disabled')
const enable = (ctx, data) => setStatus(ctx, data, 'active')

/**
 * 后台创建账号
 * 入参：{ username, password, real_name, phone, roles:[], warehouse_ids:[] }
 */
async function create(ctx, data = {}) {
  const { username, password, real_name: realName, phone } = data
  const roles = Array.isArray(data.roles) ? data.roles.filter((r) => VALID_ROLES.includes(r)) : []
  const warehouseIds = Array.isArray(data.warehouse_ids) ? data.warehouse_ids.map(Number).filter(Boolean) : []

  if (!username || !String(username).trim()) return fail(400, '登录账号不能为空')
  if (!password || String(password).length < 6) return fail(400, '密码长度不能少于 6 位')
  if (!realName || !String(realName).trim()) return fail(400, '真实姓名不能为空')
  if (!roles.length) return fail(400, '请至少分配一个角色')

  const cleanUsername = String(username).trim()
  const dup = await queryOne('SELECT id FROM users WHERE username = ?', [cleanUsername])
  if (dup) return fail(409, '该登录账号已存在')

  const hash = await bcrypt.hash(String(password), 10)

  const res = await execute(
    `INSERT INTO users (username, password_hash, real_name, phone, roles, warehouse_ids, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
    [
      cleanUsername, hash, String(realName).trim(), String(phone || ''),
      JSON.stringify(roles), JSON.stringify(warehouseIds)
    ]
  )

  const operator = operatorOf(ctx.user)
  await writeOpLog({
    openid: operator.openid, userName: operator.name, action: 'user_create', targetId: res.insertId,
    detail: `创建后台账号「${cleanUsername}」（${realName}），角色：${roles.join('、')}`, ip: ctx.ip
  })

  return ok({ _id: res.insertId }, '账号创建成功')
}

/** 重置密码 */
async function resetPassword(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  const newPassword = String(data.new_password || '')
  if (!id) return fail(400, '用户 ID 无效')
  if (newPassword.length < 6) return fail(400, '新密码长度不能少于 6 位')

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [id])
  if (!user) return fail(404, '用户不存在')

  const hash = await bcrypt.hash(newPassword, 10)
  // 管理员重置的密码属于「临时密码」，必须让本人登录后自行改掉
  await execute('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hash, id])

  const operator = operatorOf(ctx.user)
  await writeOpLog({
    openid: operator.openid, userName: operator.name, action: 'user_reset_password', targetId: id,
    detail: `重置用户「${user.real_name || user.nickname || user.username}」的密码`, ip: ctx.ip
  })

  return ok(null, '密码已重置')
}

/** 更新用户基本资料（后台） */
async function update(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '用户 ID 无效')

  const { real_name: realName, phone, username } = data
  const updates = []
  const params = []

  if (realName !== undefined) {
    updates.push('real_name = ?')
    params.push(String(realName))
  }
  if (phone !== undefined) {
    updates.push('phone = ?')
    params.push(String(phone))
  }
  if (username !== undefined && String(username).trim()) {
    const cleanUsername = String(username).trim()
    const dup = await queryOne('SELECT id FROM users WHERE username = ? AND id <> ?', [cleanUsername, id])
    if (dup) return fail(409, '该登录账号已被占用')
    updates.push('username = ?')
    params.push(cleanUsername)
  }

  if (!updates.length) return fail(400, '没有需要更新的内容')

  params.push(id)
  await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)

  return ok(null, '资料已更新')
}

/** 待审核用户数量 */
async function pendingCount(ctx) {
  const row = await queryOne("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'")
  return ok({ count: row ? row.c : 0 })
}

/**
 * 操作日志（审计）
 *
 * 整改 P1-3-01 / 3-02：老板的头号诉求是「出事能追到人」，
 * 但后台界面上原本没有任何日志入口，且 old 接口不支持翻页、不返回总数。
 * 现在提供带分页、总数、多条件筛选的审计查询。
 *
 * 入参：{ page, pageSize, keyword, action, startDate, endDate }
 */
async function logs(ctx, data = {}) {
  const { page, pageSize, offset } = paging(data, data.forExport ? 5000 : 200)
  const { keyword, action, startDate, endDate } = data

  const where = ['1 = 1']
  const params = []

  if (action) {
    where.push('action = ?')
    params.push(String(action))
  }
  if (startDate && endDate) {
    where.push('created_at >= ? AND created_at <= ?')
    params.push(new Date(`${startDate} 00:00:00`), new Date(`${endDate} 23:59:59`))
  }
  if (keyword && String(keyword).trim()) {
    const kw = `%${String(keyword).trim()}%`
    where.push('(user_name LIKE ? OR detail LIKE ? OR target_id LIKE ?)')
    params.push(kw, kw, kw)
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM operation_logs WHERE ${whereSql}`, params)
  const rows = await query(
    `SELECT * FROM operation_logs WHERE ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  // 可供前端做筛选下拉
  const actions = await query(
    'SELECT action, COUNT(*) AS c FROM operation_logs GROUP BY action ORDER BY c DESC'
  )

  return ok({
    list: toApi(rows),
    total: cnt.total,
    page,
    pageSize,
    actions: toApi(actions)
  })
}

module.exports = {
  name: 'user',
  publicActions: [],
  roleRules: {
    list: ['boss', 'admin'],
    detail: ['boss', 'admin'],
    approve: ['boss', 'admin'],
    updateRole: ['boss', 'admin'],
    disable: ['boss', 'admin'],
    enable: ['boss', 'admin'],
    create: ['boss', 'admin'],
    update: ['boss', 'admin'],
    resetPassword: ['boss', 'admin'],
    pendingCount: ['boss', 'admin'],
    // 审计日志：老板/管理员可查全量
    logs: ['boss', 'admin']
  },
  actions: {
    list, detail, approve, updateRole, disable, enable, create, update, resetPassword, pendingCount, logs
  },
  writeOpLog
}
