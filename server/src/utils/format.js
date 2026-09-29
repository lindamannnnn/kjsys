/**
 * 字段格式转换：数据库 ↔ 接口
 *
 * 关键约定：数据库主键叫 id，但接口对外统一叫 _id。
 * 原因：前端页面（24 个）原先按云开发习惯使用 _id，保持 _id 可让前端不用改动。
 */

/** JSON 类型的字段（MySQL 返回时可能已是对象，也可能是字符串，需统一成对象/数组） */
const JSON_FIELDS = [
  'roles',
  'warehouse_ids',
  'assignee_openids',
  'scope',
  'boss_openids'
]

/** 数组型 JSON 字段（null 时统一成 []，避免前端 .length 报错） */
const ARRAY_JSON_FIELDS = ['roles', 'warehouse_ids', 'assignee_openids', 'boss_openids']

/** 绝不能返回给前端的敏感字段 */
const SENSITIVE_FIELDS = ['password_hash', 'password', 'session_key', 'sessionKey']

/** 数据库行 → 接口对象（id → _id，JSON 字段规范化） */
function toApi(row) {
  if (row === null || row === undefined) return row
  if (Array.isArray(row)) return row.map(toApi)
  if (typeof row !== 'object') return row
  if (row instanceof Date) return row

  const out = {}
  for (const [k, v] of Object.entries(row)) {
    // 密码哈希等敏感字段一律不对外返回
    if (SENSITIVE_FIELDS.includes(k)) continue
    out[k] = v
  }

  // 主键改名
  if (out.id !== undefined) {
    out._id = out.id
    delete out.id
  }

  // JSON 字段规范化
  for (const f of JSON_FIELDS) {
    if (f in out) {
      let v = out[f]
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v)
        } catch (e) {
          v = null
        }
      }
      if (ARRAY_JSON_FIELDS.includes(f)) {
        if (!Array.isArray(v)) v = []
      }
      out[f] = v
    }
  }

  return out
}

/** 接口入参 → 数据库字段（_id → id） */
function toDbId(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 安全取数字（前端可能传字符串） */
function num(value, defaultValue = 0) {
  if (value === null || value === undefined || value === '') return defaultValue
  const n = Number(value)
  return Number.isFinite(n) ? n : defaultValue
}

/** 金额保留 2 位；数量保留 3 位（避免浮点误差） */
function money(value) {
  return Number(num(value).toFixed(2))
}

function qty(value) {
  return Number(num(value).toFixed(3))
}

/** 分页参数规范化
 *  @param {object} data 请求参数
 *  @param {number} maxPageSize 单次最大条数（列表接口默认 200，导出场景可放宽到 5000）
 */
function paging(data = {}, maxPageSize = 200) {
  let page = Math.floor(num(data.page, 1))
  let pageSize = Math.floor(num(data.pageSize, 20))
  if (page < 1) page = 1
  if (pageSize < 1) pageSize = 20
  if (pageSize > maxPageSize) pageSize = maxPageSize
  return { page, pageSize, offset: (page - 1) * pageSize }
}

/** 导出场景专用分页上限（一次最多取 5000 条，配合前端循环分页可导出全量） */
const EXPORT_MAX_PAGE_SIZE = 5000

/** 日期范围 → [起始, 结束)，结束日含全天 */
function dateRange(startDate, endDate) {
  const start = startDate ? new Date(`${String(startDate).slice(0, 10)} 00:00:00`) : null
  const end = endDate ? new Date(`${String(endDate).slice(0, 10)} 23:59:59`) : null
  return { start, end }
}

/** 生成当天日期串 YYYYMMDD（按北京时间） */
function todayStamp(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000) // 转北京时间
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** 是否同一天（按北京时间） */
function isSameDay(a, b) {
  return todayStamp(new Date(a)) === todayStamp(new Date(b))
}

module.exports = {
  toApi,
  toDbId,
  num,
  money,
  qty,
  paging,
  dateRange,
  todayStamp,
  isSameDay,
  JSON_FIELDS
}
