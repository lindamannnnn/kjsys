/**
 * 用户管理模块（Web 后台专用）
 */
const bcrypt = require('bcryptjs')
const { query, queryOne, execute } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, toDbId, num, paging } = require('../utils/format')
const { operatorOf, isManagement, MANAGEMENT_ROLES, identityOf } = require('../middleware/auth')

// 流程重构 V2（2026-10-03）：原 'in'（入库员）已并入 'storekeeper'（仓管员），
// 入库相关权限统一收敛到仓管；角色的增删走这里 + admin/src/constants/roles.js 两处同步。
const VALID_ROLES = ['out', 'purchase', 'storekeeper', 'boss', 'admin', 'director']

/** 角色数组里是否有「管理员」 */
function isAdminRole(roles) {
  return (Array.isArray(roles) ? roles : []).includes('admin')
}

/**
 * 该用户是否是「系统里最后一个仍在启用状态的管理员（admin）」
 *
 * ⚠️ 整改说明（V3 多岗位测试 P0-3）：原实现的查询条件是
 *   「除了他以外还有没有 admin **或 boss**」，等于把 boss 也算作管理账号。
 *   后果：「唯一管理员要把自己降级」被判定成「系统里还有 boss，安全」→ 放行，
 *   降级后系统里再没有任何 admin，而「授予 admin」又要求操作者自己是 admin →
 *   **死锁，无法自救**。
 *   boss 拥有的是业务管理权（审单、改账），admin 拥有的是系统管理权（改权限、
 *   作废已完成单据）。两者不是一回事，不能互相顶替。
 *   现在：只认 admin，保证系统里永远至少有一个 admin。
 */
async function isLastActiveAdmin(user) {
  if (!user || !isAdminRole(user.roles)) return false
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM users
      WHERE status = 'active' AND id <> ?
        AND JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('admin'))`,
    [user.id]
  )
  return num(row.c) === 0
}

/** 角色数组里是否有管理角色（用于提示语） */
function roleHasManagement(roles) {
  return MANAGEMENT_ROLES.some((r) => (roles || []).includes(r))
}

/**
 * 「管理员」角色的准入规则：只有管理员本人才能授予 admin
 *
 * ⚠️ 整改说明（V3 多岗位测试 P0-1）：原先只有 `updateRole` 里有这道判断，
 *   `create`（后台建号）与 `approve`（审核通过）都没有 → 老板可以直接
 *   `user.create {roles:["admin"]}` 凭空造一个管理员，或把待审用户审成管理员。
 *   三个入口共用本函数，避免以后再加入口时又漏掉。
 * @returns {string|null} 不通过时返回给用户看的提示语
 */
function assertCanGrantAdmin(ctx, roles) {
  if (!isAdminRole(roles)) return null
  if (isAdminRole(ctx.user && ctx.user.roles)) return null
  return '只有「管理员」才能授予「管理员」角色，请联系系统管理员操作'
}

/**
 * 「管理员」角色的准出规则：只有管理员本人才能剥夺别人的 admin
 *
 * ⚠️ 整改说明（V3 多岗位测试 P0-2）：原先只拦「授予」，不拦「剥夺」，
 *   于是老板（boss）可以把 admin 的角色改成 ["out"]，或直接把他禁用。
 *   管理员承载的是「作废已完成单据」这类不可逆操作，不能由业务角色随手摘掉。
 * @returns {string|null} 不通过时返回给用户看的提示语
 */
function assertCanRevokeAdmin(ctx, targetUser, nextRoles) {
  const targetIsAdmin = isAdminRole(targetUser && targetUser.roles)
  if (!targetIsAdmin) return null
  if (isAdminRole(nextRoles)) return null
  if (isAdminRole(ctx.user && ctx.user.roles)) return null
  return '只有「管理员」才能取消他人的「管理员」角色，请联系系统管理员操作'
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

  // 「审核通过」也是一个授予角色的入口，必须与 updateRole 同一套规则
  const denyApprove = assertCanGrantAdmin(ctx, roles)
  if (denyApprove) return fail(403, denyApprove)

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

  // ---------- 角色授予/剥夺边界 ----------
  // 老板和仓管都能进「权限管理」页面，但「管理员」能管用户、能作废已完成的单据，
  // 如果谁都能把别人（或自己）设成管理员、或者把管理员摘掉，越权就绕过去了。
  // 三个入口（create / approve / updateRole）共用同一套规则，见文件上方两个 assert 函数。
  const nextRoles = roles || (Array.isArray(user.roles) ? user.roles : [])

  // 1) 授予方向：不能授予自己没有的高阶角色
  const denyGrant = assertCanGrantAdmin(ctx, roles)
  if (denyGrant) return fail(403, denyGrant)

  // 2) 剥夺方向：不能摘掉别人的管理员角色（原先只堵了授予、没堵剥夺）
  const denyRevoke = assertCanRevokeAdmin(ctx, user, nextRoles)
  if (denyRevoke) return fail(403, denyRevoke)

  // 3) 不允许自己把自己从管理角色降级为普通员工
  if (id === ctx.user.id && isManagement(user.roles) && !roleHasManagement(nextRoles)) {
    return fail(
      400,
      '不能取消自己的管理权限（会把自己锁在系统外，将无法再改回来）。' +
      '如确实要调整，请让另一位管理员在「用户管理」里为你修改'
    )
  }

  // 4) 保证系统里永远至少有一个管理员（否则「作废已完成单据」等操作将无人可做，
  //    且由于「授予 admin 需要自己是 admin」，降级后无法自救）
  if (!isAdminRole(nextRoles) && (await isLastActiveAdmin(user))) {
    return fail(
      400,
      `不能再降低「${user.real_name || user.username}」的权限：` +
      `他/她当前是系统里唯一的「管理员」，降级后将没有任何人能调整权限、作废单据和管理用户`
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
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'user_update_role', targetId: id,
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

  // 只有管理员能禁用管理员（否则老板一句话就能把系统管理员关掉）
  if (status === 'disabled' && isAdminRole(user.roles) && !isAdminRole(ctx.user.roles)) {
    return fail(403, '只有「管理员」才能禁用管理员账号，请联系系统管理员操作')
  }

  // 不允许禁用系统里最后一个管理员（否则审批/改账/授权全停摆，且无法自救）
  if (status === 'disabled' && (await isLastActiveAdmin(user))) {
    return fail(
      400,
      `不能禁用「${user.real_name || user.username}」：他/她当前是系统里唯一的「管理员」，` +
      `禁用后将没有任何人能调整权限、作废单据和管理用户`
    )
  }

  await execute('UPDATE users SET status = ? WHERE id = ?', [status, id])

  const operator = operatorOf(ctx.user)
  await writeOpLog({
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
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
  const { username, password, real_name: realName, phone, wecom_userid: wecomUserid } = data
  const roles = Array.isArray(data.roles) ? data.roles.filter((r) => VALID_ROLES.includes(r)) : []
  const warehouseIds = Array.isArray(data.warehouse_ids) ? data.warehouse_ids.map(Number).filter(Boolean) : []

  if (!username || !String(username).trim()) return fail(400, '登录账号不能为空')
  if (!password || String(password).length < 6) return fail(400, '密码长度不能少于 6 位')
  if (!realName || !String(realName).trim()) return fail(400, '真实姓名不能为空')
  if (!roles.length) return fail(400, '请至少分配一个角色')

  // 建号也是授予角色的入口：非管理员不能在这里造出管理员账号（原先漏了这道校验）
  const denyGrant = assertCanGrantAdmin(ctx, roles)
  if (denyGrant) return fail(403, denyGrant)

  const cleanUsername = String(username).trim()
  const dup = await queryOne('SELECT id FROM users WHERE username = ?', [cleanUsername])
  if (dup) return fail(409, '该登录账号已存在')

  const hash = await bcrypt.hash(String(password), 10)

  const res = await execute(
    `INSERT INTO users (username, password_hash, real_name, phone, wecom_userid, roles, warehouse_ids, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NOW())`,
    [
      cleanUsername, hash, String(realName).trim(), String(phone || ''), String(wecomUserid || '').trim(),
      JSON.stringify(roles), JSON.stringify(warehouseIds)
    ]
  )

  const operator = operatorOf(ctx.user)
  await writeOpLog({
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'user_create', targetId: res.insertId,
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
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'user_reset_password', targetId: id,
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
  if (data.wecom_userid !== undefined) {
    updates.push('wecom_userid = ?')
    params.push(String(data.wecom_userid || '').trim())
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

  // 主数据改动必须留痕（V3 测试 P1-9：原先改用户资料完全不写日志，出了事查不到人）
  const operator = operatorOf(ctx.user)
  const changedFields = updates.map((u) => u.split(' = ')[0]).join('、')
  await writeOpLog({
    openid: operator.openid, userName: operator.name,
    role: (ctx.user.roles || []).join(','),
    action: 'user_update', targetId: id,
    detail:
      `修改用户资料（${changedFields}）` +
      (realName !== undefined ? `，姓名改为「${realName}」` : '') +
      (username !== undefined ? `，账号改为「${username}」` : '') +
      (phone !== undefined ? '，手机号已更新' : ''),
    ip: ctx.ip
  })

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

/**
 * 盘点人员候选（只回最小字段）
 *
 * ⚠️ 2026-10-09 新增（第二批）：仓管 / 厂长要在后台「创建盘点」，
 *   那个页面原来靠 `user.list` 拉人——而 `user.list` 只给 admin/boss，
 *   于是仓管一进后台建盘点，人员下拉永远空的（接口 403，页面还只是 console.warn）。
 *   这里单开一个「只回 id + 姓名 + 角色」的窄接口，让盘点发起人也能选到人，
 *   既补上功能，也不把手机号之类的员工隐私铺开。
 *
 * 入参：{ keyword, warehouse_id }
 * 返回：{ list: [{ _id, name, roles }] }
 */
async function assignees(ctx, data = {}) {
  const { keyword } = data

  /**
   * ⚠️ 这里是全系统**唯一**刻意用「openid 有无」筛人的地方，已显式豁免 lint（见下方标记）。
   *
   * 理由：盘点执行人必须能在**小程序**里执行 / 确认盘点，而小程序登录是
   *       `SELECT * FROM users WHERE openid = ?`（modules/auth.js login）——
   *       没有 openid 的账号永远匹配不上，登进去只会另建一个 pending 账号。
   *       所以「有 openid」= 「能真正执行盘点的人」。
   *
   * 2026-10-16 经生产库核实（此前一度误判为缺陷，特此留档）：
   *   · 文彬 id=41（2026-10-14 建，**有 openid**）—— 系统目前唯一真实人员，兼 boss/out/storekeeper
   *   · 张三/李娜/赵六/王总 id=7~10（2026-09-29 17:37:46 同一秒批量建成，**无 openid**）
   *     —— 演示账号，本就登不进小程序
   *   → 下拉只出 1 人 = 生产真实情况，不是 bug。
   *   前一次「赵六当盘点执行人」的"证据"，实为本次盘查时自建的测试盘点单（116），不作数。
   *
   * 已知副作用（须知，非缺陷）：后台手工建的真实员工账号，在其本人用小程序登录前，
   *   不会出现在此下拉里。正规入职路径 = 员工先从小程序进来建号 → 后台审核并分配角色。
   */
  // preflight-allow: BARE-OPENID-NULL — 盘点执行人须能登录小程序执行盘点，无 openid 账号登不进
  const where = ["status = 'active'", 'openid IS NOT NULL', "openid <> ''"]
  const params = []

  // 只有「小程序用户」才有 openid，也只有他们能当盘点执行人（后台账号进不了小程序）
  if (keyword && String(keyword).trim()) {
    const kw = `%${String(keyword).trim()}%`
    where.push('(real_name LIKE ? OR nickname LIKE ?)')
    params.push(kw, kw)
  }

  const rows = await query(
    `SELECT id, real_name, nickname, roles, openid
       FROM users
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT 500`,
    params
  )

  return ok({
    list: rows.map((r) => ({
      _id: r.id,
      name: r.real_name || r.nickname || `用户${r.id}`,
      // openid 是 check.create 的 assignee_openids 要的值，必须给；
      // 但手机号 / 账号 / 密码哈希这类字段**一律不返回**（这个接口给的是仓管和厂长）
      openid: r.openid,
      roles: toApi({ roles: r.roles }).roles || []
    }))
  })
}

module.exports = {
  name: 'user',
  publicActions: [],
  roleRules: {
    // ⚠️ 2026-10-09 用户要求「老板彻底只读」：
    //   只保留**查看**类（列表/详情/待审数/审计日志），
    //   审批与账号写入（approve/updateRole/disable/enable/create/update/resetPassword）全部收回 boss，
    //   员工账号管理归 管理员。
    list: ['boss', 'admin'],
    detail: ['boss', 'admin'],
    approve: ['admin'],
    updateRole: ['admin'],
    disable: ['admin'],
    enable: ['admin'],
    create: ['admin'],
    update: ['admin'],
    resetPassword: ['admin'],
    pendingCount: ['boss', 'admin'],
    // 审计日志：老板/管理员可查全量
    logs: ['boss', 'admin'],
    // 盘点人员候选：盘点发起人（仓管/厂长）也要能选人，故一并放行；
    // 返回体只有 id + 姓名 + 角色，不含手机号等隐私字段
    assignees: ['storekeeper', 'director', 'boss', 'admin']
  },
  actions: {
    list, detail, approve, updateRole, disable, enable, create, update, resetPassword, pendingCount, logs, assignees
  },
  writeOpLog
}
