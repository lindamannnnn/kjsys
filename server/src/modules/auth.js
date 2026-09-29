/**
 * 认证模块
 * 小程序：微信 code2session 换 openid → 查/建用户 → 签发 JWT
 * 后台：账号密码登录 → 签发 JWT
 */
const bcrypt = require('bcryptjs')
const { query, queryOne, execute } = require('../db/pool')
const { ok, fail, errors } = require('../utils/response')
const { toApi, num, paging } = require('../utils/format')
const { code2session, isDevLoginAllowed } = require('../services/wechat')
const { signToken, displayName } = require('../middleware/auth')

/** 写操作日志 */
async function writeOpLog(p) {
  try {
    await execute(
      `INSERT INTO operation_logs (openid, user_name, role, action, target_type, target_id, detail, result, fail_reason, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        p.openid || '', p.userName || '', p.role || '', p.action || '',
        p.targetType || '', String(p.targetId || ''), p.detail || '',
        p.result || 'success', p.failReason || '', p.ip || ''
      ]
    )
  } catch (e) {
    console.error('[操作日志写入失败]', e.message)
  }
}

/**
 * 登录
 * 入参：{ code }            小程序 wx.login 拿到的 code
 *       { dev_openid }      仅本地开发（需 ALLOW_DEV_LOGIN=true）
 * 已登录用户再次调用（无 code）时，直接返回当前身份，便于前端 checkLogin
 */
async function login(ctx, data = {}) {
  const { code, dev_openid: devOpenid, nickname, avatar } = data
  let openid = ''

  if (code) {
    const r = await code2session(code)
    openid = r.openid
  } else if (devOpenid && isDevLoginAllowed()) {
    openid = String(devOpenid)
  } else if (ctx.user && ctx.user.openid) {
    openid = ctx.user.openid
  } else {
    return fail(400, '缺少登录凭证：请先调用 wx.login 获取 code')
  }

  let user = await queryOne('SELECT * FROM users WHERE openid = ? LIMIT 1', [openid])

  // ---- 新用户：自动建档，状态为待审核 ----
  if (!user) {
    const res = await execute(
      `INSERT INTO users (openid, nickname, avatar, roles, warehouse_ids, status, created_at, last_login_at)
       VALUES (?, ?, ?, JSON_ARRAY(), JSON_ARRAY(), 'pending', NOW(), NOW())`,
      [openid, nickname || '', avatar || '']
    )
    user = await queryOne('SELECT * FROM users WHERE id = ?', [res.insertId])

    await writeOpLog({
      openid, action: 'register', targetType: 'user', targetId: user.id,
      detail: '新用户首次进入系统，待管理员审核', ip: ctx.ip
    })

    const apiUser = toApi(user)
    return ok({
      openid,
      user: apiUser,
      roles: [],
      isNew: true,
      token: signToken(user),
      needRegister: true
    }, '首次进入，请完善资料等待审核')
  }

  // ---- 老用户：更新登录时间与微信资料 ----
  const updates = ['last_login_at = NOW()']
  const params = []
  if (nickname) {
    updates.push('nickname = ?')
    params.push(nickname)
  }
  if (avatar) {
    updates.push('avatar = ?')
    params.push(avatar)
  }
  params.push(user.id)
  await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)

  user = await queryOne('SELECT * FROM users WHERE id = ?', [user.id])
  const apiUser = toApi(user)

  await writeOpLog({
    openid, userName: displayName(apiUser), role: (apiUser.roles || []).join(','),
    action: 'login', targetType: 'user', targetId: user.id, detail: '微信登录', ip: ctx.ip
  })

  return ok({
    openid,
    user: apiUser,
    roles: apiUser.roles || [],
    isNew: false,
    token: signToken(user),
    needRegister: !apiUser.real_name
  })
}

/**
 * 注册（首次填写真实姓名）—— 需先登录拿到令牌
 */
async function register(ctx, data = {}) {
  const { real_name: realName, phone } = data

  if (!realName || !String(realName).trim()) {
    return fail(400, '真实姓名不能为空')
  }
  if (!ctx.user) {
    return fail(401, '请先登录')
  }

  // 同名同手机号防重复注册
  const dup = await queryOne(
    'SELECT id FROM users WHERE real_name = ? AND phone = ? AND id <> ? LIMIT 1',
    [String(realName).trim(), phone || '', ctx.user.id]
  )
  if (dup) {
    return fail(409, '该姓名与手机号已注册，请联系管理员')
  }

  await execute(
    `UPDATE users SET real_name = ?, phone = ?, status = 'pending' WHERE id = ?`,
    [String(realName).trim(), phone || '', ctx.user.id]
  )

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [ctx.user.id])

  await writeOpLog({
    openid: ctx.user.openid, userName: realName, action: 'register',
    targetType: 'user', targetId: ctx.user.id, detail: `提交注册资料：${realName}`, ip: ctx.ip
  })

  return ok({ user: toApi(user) }, '注册资料已提交，等待管理员审核')
}

/** 更新个人资料 */
async function updateProfile(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const { real_name: realName, phone, nickname } = data
  const updates = []
  const params = []

  if (realName !== undefined && String(realName).trim()) {
    updates.push('real_name = ?')
    params.push(String(realName).trim())
  }
  if (phone !== undefined) {
    updates.push('phone = ?')
    params.push(String(phone))
  }
  if (nickname !== undefined && nickname) {
    updates.push('nickname = ?')
    params.push(String(nickname))
  }

  if (!updates.length) return ok(null, '没有需要更新的内容')

  params.push(ctx.user.id)
  await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [ctx.user.id])
  return ok({ user: toApi(user) }, '资料已更新')
}

/** 获取当前用户信息 */
async function getUserInfo(ctx) {
  if (!ctx.user) return fail(401, '请先登录')
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [ctx.user.id])
  if (!user) return fail(404, '用户不存在')
  return ok(toApi(user))
}

/**
 * Web 后台登录（账号密码）
 */
async function adminLogin(ctx, data = {}) {
  const { username, password } = data

  if (!username || !password) {
    return fail(400, '请输入账号和密码')
  }

  const user = await queryOne('SELECT * FROM users WHERE username = ? LIMIT 1', [String(username).trim()])
  if (!user || !user.password_hash) {
    await writeOpLog({
      openid: String(username), action: 'admin_login', result: 'fail',
      failReason: '账号不存在或未设密码', ip: ctx.ip
    })
    return fail(400, '账号或密码错误')
  }

  const matched = await bcrypt.compare(String(password), user.password_hash)
  if (!matched) {
    await writeOpLog({
      openid: String(username), action: 'admin_login', result: 'fail',
      failReason: '密码错误', ip: ctx.ip
    })
    return fail(400, '账号或密码错误')
  }

  if (user.status === 'disabled') {
    return fail(403, '账号已被禁用，请联系管理员')
  }
  if (user.status === 'pending') {
    return fail(403, '账号正在审核中，审核通过后即可登录')
  }

  // 说明：不限制角色。后台各菜单与接口都有独立的角色权限校验，
  //      普通员工登录后只能看到自己权限范围内的内容。

  await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id])

  await writeOpLog({
    openid: user.openid || user.username, userName: displayName(user),
    action: 'admin_login', targetType: 'user', targetId: user.id, detail: '后台登录成功', ip: ctx.ip
  })

  const apiUser = toApi(user)
  const mustChange = Number(user.must_change_password) === 1

  return ok({
    token: signToken(user),
    user: apiUser,
    roles: apiUser.roles || [],
    // 整改 P0-2-02：初始密码（admin123456）不仅能登录超管，还长期有效。
    // 现在首登即要求改密，未改密前除改密接口外一律 403
    must_change_password: mustChange
  }, mustChange ? '登录成功，请立即修改初始密码' : '登录成功')
}

/** 修改密码（后台账号） */
async function changePassword(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const { old_password: oldPassword, new_password: newPassword } = data
  if (!newPassword || String(newPassword).length < 6) {
    return fail(400, '新密码长度不能少于 6 位')
  }

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [ctx.user.id])
  if (!user) return fail(404, '用户不存在')

  if (user.password_hash) {
    const matched = await bcrypt.compare(String(oldPassword || ''), user.password_hash)
    if (!matched) return fail(400, '原密码不正确')
  }

  const hash = await bcrypt.hash(String(newPassword), 10)
  // 改密成功后清除「必须改密」标记（整改 P0-2-02 的门禁由此解除）
  await execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, ctx.user.id])

  await writeOpLog({
    openid: user.openid || user.username, userName: displayName(user),
    action: 'change_password', targetType: 'user', targetId: user.id, detail: '修改密码', ip: ctx.ip
  })

  return ok(null, '密码修改成功')
}

/**
 * 查询当前用户的操作日志（用于"我的"页面）
 * 整改 P2-3：原来固定 limit 且不返回 total，分页算不出页数
 */
async function myLogs(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const { page, pageSize, offset } = paging(data)
  const me = ctx.user.openid || ctx.user.username || ''

  const cnt = await queryOne(
    'SELECT COUNT(*) AS total FROM operation_logs WHERE openid = ?',
    [me]
  )
  const list = await query(
    'SELECT * FROM operation_logs WHERE openid = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [me, pageSize, offset]
  )

  return ok({ list: toApi(list), total: num(cnt.total), page, pageSize })
}

module.exports = {
  name: 'auth',
  publicActions: ['login', 'adminLogin'],
  roleRules: {},
  actions: {
    login,
    register,
    updateProfile,
    getUserInfo,
    adminLogin,
    changePassword,
    myLogs
  },
  writeOpLog
}
