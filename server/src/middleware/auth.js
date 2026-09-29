/**
 * 身份认证：JWT 令牌签发与校验
 * 替代原云开发的 cloud.getWXContext().OPENID
 */
const jwt = require('jsonwebtoken')
const { queryOne } = require('../db/pool')
const { toApi } = require('../utils/format')

const SECRET = process.env.JWT_SECRET || 'change-me-to-a-long-random-string'
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'

/** 签发令牌 */
function signToken(user) {
  return jwt.sign(
    {
      uid: user.id,
      openid: user.openid || '',
      username: user.username || ''
    },
    SECRET,
    { expiresIn: EXPIRES_IN }
  )
}

/** 校验令牌，失败返回 null（不抛错，由调用方决定如何处理） */
function verifyToken(token) {
  if (!token) return null
  try {
    return jwt.verify(token, SECRET)
  } catch (e) {
    return null
  }
}

/** 从请求头提取令牌 */
function extractToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || ''
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim()
  }
  return ''
}

/** 按令牌里的 uid 加载用户（同时拿到最新的角色与状态） */
async function loadUser(jwtPayload) {
  if (!jwtPayload || !jwtPayload.uid) return null
  const row = await queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [row_id(jwtPayload.uid)])
  if (!row) return null

  // 对外字段（含 _id，已剔除密码哈希）
  const user = toApi(row)
  // 服务端内部逻辑依赖数字主键 id（如"不能禁用自己"的判断），这里补回来
  user.id = row.id
  return user
}

/** 主键规整（防止令牌里的值被篡改） */
function row_id(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : -1
}

/**
 * 角色校验
 * admin 视为超级权限，通过一切校验
 */
function hasAnyRole(user, roles) {
  if (!roles || roles.length === 0) return true
  const userRoles = (user && user.roles) || []
  if (userRoles.includes('admin')) return true
  return roles.some((r) => userRoles.includes(r))
}

/** 取用户显示名（用于流水与日志） */
function displayName(user) {
  if (!user) return '未知用户'
  return user.real_name || user.nickname || user.username || '未知用户'
}

/**
 * 取用户唯一身份标识（用于单据归属、流水、日志）
 *
 * ⚠️ 整改说明（来自 4 角色使用者测试）：
 *   原实现「写入时用 openid || username 兜底，读取时有的地方只用 openid」，
 *   两边不一致就会出现「自己看不到自己的单据」。现统一走本函数。
 */
function identityOf(user) {
  if (!user) return ''
  return user.openid || user.username || ''
}

/** 管理类角色（能改账、能审单、能管人） */
const MANAGEMENT_ROLES = ['admin', 'boss']

/** 角色数组里是否含管理类角色 */
function isManagement(roles) {
  const list = Array.isArray(roles) ? roles : []
  return MANAGEMENT_ROLES.some((r) => list.includes(r))
}

/** 操作者信息（供库存流水使用） */
function operatorOf(user) {
  return {
    openid: identityOf(user),
    name: displayName(user)
  }
}

module.exports = {
  signToken,
  verifyToken,
  extractToken,
  loadUser,
  hasAnyRole,
  displayName,
  identityOf,
  isManagement,
  MANAGEMENT_ROLES,
  operatorOf,
  SECRET,
  EXPIRES_IN
}
