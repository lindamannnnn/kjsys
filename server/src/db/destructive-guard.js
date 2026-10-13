/**
 * ============================================================
 * 破坏性操作安全闸门（默认拒绝）
 * ------------------------------------------------------------
 * 为什么需要：生产环境跑的是**同一份代码**、库名同为 `shenglong`，
 *   而清理/播种/批量改写脚本一旦在生产被跑一次，就是**不可逆的数据丢失**。
 *   （2026-10-12 真实事故：本地清理脚本按 `dev_` 账号口径误删了用户的真实出库单。）
 *
 * 设计：**默认拒绝（fail-safe）**，必须同时满足两个条件才放行：
 *   1. `NODE_ENV !== 'production'`   ← 生产环境**永远**拒绝，无任何绕过手段
 *   2. `ALLOW_DESTRUCTIVE === '1'`   ← 必须显式开启（写在本机 server/.env，不进 Git）
 *
 * 两个条件是**与**关系，各自独立生效：
 *   - 生产环境即使误配了 ALLOW_DESTRUCTIVE=1，也会被条件 1 拦住
 *   - 非生产环境若没显式开启，也会被条件 2 拦住（防止手滑）
 *
 * ⚠️ 生产环境务必保证：
 *   - `NODE_ENV=production`（`.env.example` / docker-compose 默认就是）
 *   - `.env` 里**不要**出现 `ALLOW_DESTRUCTIVE=1`
 *
 * 用法（放在脚本 main 的最前面）：
 *   const { assertDestructive } = require('../src/db/destructive-guard')
 *   assertDestructive('清理测试数据', '将删除带测试标记的物料/单据/流水')
 *
 * 想「警告但不中止」的调用方（如测试收尾清理）用 `checkDestructive()`：
 *   const r = checkDestructive('...'); if (!r.ok) { console.warn(...); return }
 * ============================================================
 */
require('../config/env')

const ALLOW_ENV = 'ALLOW_DESTRUCTIVE'
const isProduction = () => process.env.NODE_ENV === 'production'
const isAllowed = () => process.env[ALLOW_ENV] === '1'

/** 目标数据库坐标（脱敏，不打印密码） */
function describeTarget() {
  const host = process.env.DB_HOST || '127.0.0.1'
  const port = process.env.DB_PORT || 3306
  const name = process.env.DB_NAME || 'shenglong'
  const user = process.env.DB_USER || 'shenglong'
  return `${user}@${host}:${port}/${name}`
}

/**
 * 判断是否允许执行破坏性操作（不退出进程）
 * @param {string} what 操作名（如「清理测试数据」）
 * @returns {{ok: boolean, reason: string}}
 */
function checkDestructive(what = '破坏性操作') {
  if (isProduction()) {
    return {
      ok: false,
      reason: 'NODE_ENV=production：生产环境禁止执行任何破坏性脚本'
    }
  }
  if (!isAllowed()) {
    return {
      ok: false,
      reason: `未设置 ${ALLOW_ENV}=1：破坏性脚本默认拒绝执行`
    }
  }
  return { ok: true, reason: '' }
}

/** 拒绝时的醒目提示 */
function refuse(what, detail, reason) {
  const line = '='.repeat(64)
  console.error('\n' + line)
  console.error(`  ⛔ 已拒绝执行：${what}`)
  console.error(line)
  console.error(`  目标数据库：${describeTarget()}`)
  console.error(`  环境：NODE_ENV=${process.env.NODE_ENV || '(未设置)'}  ${ALLOW_ENV}=${process.env[ALLOW_ENV] || '(未设置)'}`)
  if (detail) console.error(`  本操作会：${detail}`)
  console.error(`\n  原因：${reason}`)
  console.error('\n  这是**保护措施**，不是故障。')
  console.error('  - 若这是**生产环境**：请勿执行，此脚本本就不该在生产运行。')
  console.error(`  - 若这是**本机开发**：在本机 server/.env 里加一行 ${ALLOW_ENV}=1 后重试。`)
  console.error('  ⚠️ 生产 .env 绝不能有这个开关。')
  console.error(line + '\n')
}

/**
 * 断言允许破坏性操作；不允许则**打印醒目提示并退出进程（exit 2）**
 * @param {string} what 操作名
 * @param {string} [detail] 会删/改什么（给人看的告警）
 */
function assertDestructive(what = '破坏性操作', detail = '') {
  const r = checkDestructive(what)
  if (!r.ok) {
    refuse(what, detail, r.reason)
    process.exit(2)
  }
  console.log(`[安全闸门] 放行：${what}（目标 ${describeTarget()}，NODE_ENV=${process.env.NODE_ENV || '未设置'}）`)
  return true
}

module.exports = { checkDestructive, assertDestructive, describeTarget, isProduction, isAllowed }
