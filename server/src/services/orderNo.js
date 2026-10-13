/**
 * 单号生成：OUT-20260929-001 / IN-20260929-001 / CHK-20260929-001 / CG-20260929-001
 *
 * 并发安全策略：
 *   1. 取当天最大序号 + 1
 *   2. 表上单号列有唯一索引；若并发撞号，插入会失败
 *   3. 调用方捕获重复键错误后重试（见 withRetryOnDuplicate）
 */
const { queryOne } = require('../db/pool')
const { todayStamp } = require('../utils/format')

const TABLE_MAP = {
  outbound: { table: 'outbound_orders', prefix: 'OUT', col: 'order_no' },
  inbound: { table: 'inbound_orders', prefix: 'IN', col: 'order_no' },
  check: { table: 'stock_checks', prefix: 'CHK', col: 'check_no' },
  // 采购任务单（流程重构 V2 · P4）：CG = 采购
  purchase: { table: 'purchase_tasks', prefix: 'CG', col: 'task_no' }
}

/**
 * 生成下一个单号
 * @param {object} conn 事务连接（保证与后续插入在同一事务）
 * @param {'outbound'|'inbound'|'check'|'purchase'} kind
 */
async function nextOrderNo(conn, kind) {
  const cfg = TABLE_MAP[kind]
  if (!cfg) throw new Error(`未知单号类型: ${kind}`)

  const stamp = todayStamp()
  const prefix = `${cfg.prefix}-${stamp}-`
  const col = cfg.col

  const row = await queryOne(
    `SELECT ${col} AS no FROM ${cfg.table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`,
    [`${prefix}%`],
    conn
  )

  let seq = 1
  if (row && row.no) {
    const n = parseInt(String(row.no).slice(prefix.length), 10)
    if (Number.isFinite(n) && n > 0) seq = n + 1
  }

  return `${prefix}${String(seq).padStart(3, '0')}`
}

/**
 * 遇到唯一键冲突（并发撞号）时自动重试
 * @param {function(string): Promise<any>} fn 接收单号，返回执行结果
 */
async function withRetryOnDuplicate(conn, kind, fn, maxRetry = 5) {
  let lastErr = null
  for (let i = 0; i < maxRetry; i++) {
    const orderNo = await nextOrderNo(conn, kind)
    try {
      return await fn(orderNo)
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        lastErr = err
        continue // 撞号，换一个再试
      }
      throw err
    }
  }
  throw lastErr || new Error('单号生成失败，请重试')
}

module.exports = { nextOrderNo, withRetryOnDuplicate }
