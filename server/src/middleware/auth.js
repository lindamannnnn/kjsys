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

/** 纯领料员（只有 out 角色）：不可见库存数量/成本，缺不缺货由仓管把关 */
function isPureOutUser(user) {
  const roles = Array.isArray(user && user.roles) ? user.roles : []
  return roles.includes('out') && !roles.some((r) => ['storekeeper', 'boss', 'admin', 'purchase'].includes(r))
}

/**
 * 成本价可见角色（2026-10-10 新增）
 *
 * 口径：**仓库端只看数量、不看钱**。成本价属于经营数据，仓管（成品仓 / 配件仓）
 * 一律不下发；兼任管理类或采购角色时按「角色并集」放开。
 *
 * ⚠️ 与 isPureOutUser 的分工，别混：
 *   领料员 → maskStockFields：连库存**数量**都看不到（缺不缺货由仓管把关）
 *   仓管   → maskCostFields ：数量看得到，**金额**看不到
 */
const COST_VISIBLE_ROLES = ['admin', 'boss', 'director', 'purchase']

/** 该用户是否要脱敏成本价（仓管且不兼任任何可见成本的角色） */
function isCostHiddenUser(user) {
  const roles = Array.isArray(user && user.roles) ? user.roles : []
  if (!roles.includes('storekeeper')) return false
  return !roles.some((r) => COST_VISIBLE_ROLES.includes(r))
}

/**
 * 成本脱敏：只抹成本价。
 * 库存价值 = 成本价 × 数量，由前端算出，源头没了自然不会泄露。
 */
function maskCostFields(rows) {
  const arr = Array.isArray(rows) ? rows : [rows]
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    delete r.avg_cost
  }
  return rows
}

/** 配件仓 code —— 全站唯一一处按 code 判「配件仓」（见 maskInboundMoney 的注释） */
const PARTS_WAREHOUSE_CODE = 'peijian'

/** 该仓库是不是配件仓 */
function isPartsWarehouse(code) {
  return String(code || '') === PARTS_WAREHOUSE_CODE
}

/**
 * 金额字段全集（2026-10-10 扩展：仓管金额全面收口）
 *
 * ⚠️ 与 maskCostFields 的区别：
 *   maskCostFields —— 只抹「成本价」，用在物料列表/详情（仓管端那两张表整列都藏）
 *   maskMoneyFields —— 连「库存价值 / 单据金额」一起抹，用在统计、看板、单据流水
 * 两者删除的都是**值**（不是置 0）——前端按 `undefined` 判空并显示「—」，
 * 避免把「看不到」误读成「金额为 0」。
 */
const MONEY_FIELDS = [
  'avg_cost',            // 成本价
  'stock_value',         // 库存价值（单行）= 成本价 × 数量
  'total_value',         // 库存价值（汇总）
  'total_amount',        // 单据金额
  'total_price',         // 单据金额（入库单/采购单）
  'unit_price',          // 单价
  'today_outbound_amount', // 看板：今日出库金额
  'today_inbound_amount',  // 看板：今日入库金额
  'period_outbound_amount',// 看板：区间出库金额
  'period_inbound_amount'  // 看板：区间入库金额
]

/** 按字段名批量抹金额（默认抹 MONEY_FIELDS 全集，可传 fields 只抹其中几个） */
function maskMoneyFields(rows, fields = MONEY_FIELDS) {
  const arr = Array.isArray(rows) ? rows : [rows]
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    for (const f of fields) delete r[f]
  }
  return rows
}

/** 领料员数据脱敏：物料列表/详情里的库存与成本字段一律抹掉 */
function maskStockFields(rows) {
  const arr = Array.isArray(rows) ? rows : [rows]
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    delete r.current_stock
    delete r.avg_cost
    delete r.warning_stock
    delete r.stock_value
    delete r.total_stock
    delete r.total_value
  }
  return rows
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
  isPureOutUser,
  maskStockFields,
  COST_VISIBLE_ROLES,
  isCostHiddenUser,
  maskCostFields,
  MONEY_FIELDS,
  maskMoneyFields,
  PARTS_WAREHOUSE_CODE,
  isPartsWarehouse,
  SECRET,
  EXPIRES_IN
}
