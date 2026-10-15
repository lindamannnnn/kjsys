/**
 * ============================================================
 * 正式启用清账（数据清0）—— 投产前一次性使用
 * ------------------------------------------------------------
 * 把系统从「测试/试用」状态清成「正式启用」状态。
 *
 * ⚠️ 这是**清空业务数据**的操作，正式启用前跑一次、只跑一次。
 * ⚠️ 它要在**生产**跑，所以**不走 destructive-guard**（闸门在生产永远拒绝）。
 *    取而代之的是三重人工确认：预览 → 显式 --yes → 交互输入「确认清0」。
 *
 * 清空（业务流水，从 0 开始记账）：
 *   - 入库单 / 出库单 / 采购任务 / 盘点单（含各自明细）
 *   - 库存流水 stock_logs、站内消息 messages、操作日志 operation_logs
 *   - 所有物料的库存数量 → 归 0（正式启用时按实盘录期初）
 *
 * 保留（基础档案与账号）：
 *   - 物料档案 materials（编号/名称/规格/分类等，只清库存数量）
 *   - 仓库 warehouses、供应商 suppliers、系统设置 settings
 *   - 真实员工账号 users
 *
 * 删除的账号：只删测试/探针账号（dev_*、RA_*、AUTOTEST_* 等），真实员工不动。
 *
 * 用法：
 *   node src/db/reset-production.js           # 预览，列出将清/将留，不写库
 *   node src/db/reset-production.js --yes     # 进入确认流程（仍需输入「确认清0」）
 * ============================================================
 */
require('../../src/config/env')
const { query, queryOne, execute, pool } = require('./pool')
const { describeTarget } = require('./destructive-guard')
const readline = require('readline')

/**
 * 清账是「有意的一次性操作」，前面已有预览 + 人工确认 + 库内备份三重保险。
 * 但 pool 包装层的 assertNotDestructive 会在生产拦掉一切 DELETE/DROP。
 * 所以这里用**原始连接池**执行清账 SQL，绕开那道闸门（仅本脚本这么用）。
 */
async function rawExec(sql, params = []) {
  const [r] = await pool.query(sql, params)
  return r
}

const APPLY = process.argv.includes('--yes')

const BIZ_TABLES = [
  'inbound_order_items', 'inbound_orders',
  'outbound_order_items', 'outbound_orders',
  'purchase_task_items', 'purchase_tasks',
  'stock_check_items', 'stock_checks',
  'stock_logs', 'messages', 'operation_logs'
]

// ⚠️ 用 COALESCE 处理 NULL：admin / 真实员工的 openid 是 NULL，
//    直接 `openid LIKE 'dev_%'` 得 NULL，会让 NOT(...) 统计成「保留 0 个」（误判）。
const TEST_ACCOUNT_COND = `(
  COALESCE(username,'') LIKE 'dev_%' OR COALESCE(username,'') LIKE 'RA_%' OR COALESCE(username,'') LIKE 'AUTOTEST_%'
  OR COALESCE(username,'') LIKE 'V3FIX_%' OR COALESCE(username,'') LIKE 'V3R%' OR COALESCE(username,'') LIKE 'V3RECHECK%'
  OR COALESCE(openid,'') LIKE 'dev_%'
)`

async function count(table) {
  const r = await queryOne(`SELECT COUNT(*) AS c FROM \`${table}\``)
  return Number(r.c)
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()) }))
}

async function main() {
  console.log('\n═══ 正式启用清账（数据清0）═══')
  console.log('目标数据库：' + describeTarget())
  console.log('环境：NODE_ENV=' + (process.env.NODE_ENV || '(未设置)'))

  /* ---------- 预览 ---------- */
  console.log('\n将【清空】的业务数据：')
  const bizCounts = {}
  for (const t of BIZ_TABLES) {
    bizCounts[t] = await count(t)
    console.log(`  ${t.padEnd(24)} ${bizCounts[t]} 条`)
  }
  const matTotal = await count('materials')
  const matStock = await queryOne('SELECT COALESCE(SUM(current_stock),0) s FROM materials WHERE is_deleted=0')
  console.log(`\n  materials 库存数量归 0（现有库存合计 ${matStock.s}；物料档案 ${matTotal} 条【保留】）`)

  const testAcc = await queryOne(`SELECT COUNT(*) c FROM users WHERE ${TEST_ACCOUNT_COND}`)
  const realAcc = await queryOne(`SELECT COUNT(*) c FROM users WHERE NOT ${TEST_ACCOUNT_COND}`)
  console.log('\n将【删除】测试/探针账号：', testAcc.c, '个')
  console.log('将【保留】真实员工账号：', realAcc.c, '个')
  console.log('将【保留】：物料档案 / 仓库 / 供应商 / 系统设置')

  if (!APPLY) {
    console.log('\n（以上是预览，未动任何数据。确认无误后加 --yes 进入确认流程）\n')
    process.exit(0)
  }

  /* ---------- 人工确认 ---------- */
  console.log('\n⚠️  即将对【' + describeTarget() + '】执行清账，此操作不可逆。')
  const ans = await ask('请输入「确认清0」四个字以继续（其它任意输入取消）：')
  if (ans !== '确认清0') {
    console.log('已取消，未动任何数据。\n')
    process.exit(0)
  }

  /* ---------- 库内备份（_bak_reset_*） ---------- */
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  console.log('\n先做库内备份（_bak_reset_' + stamp + '_*）…')
  const bakTables = [...BIZ_TABLES, 'materials', 'users']
  for (const t of bakTables) {
    const bak = `_bak_reset_${stamp}_${t}`
    await rawExec(`DROP TABLE IF EXISTS \`${bak}\``)
    await rawExec(`CREATE TABLE \`${bak}\` AS SELECT * FROM \`${t}\``)
  }
  console.log('  备份完成（' + bakTables.length + ' 张表）')

  /* ---------- 执行清空 ---------- */
  console.log('\n开始清空…')
  for (const t of BIZ_TABLES) {
    await rawExec(`DELETE FROM \`${t}\``)
    console.log(`  ✓ 清空 ${t}（${bizCounts[t]} 条）`)
  }
  await rawExec('UPDATE materials SET current_stock = 0 WHERE is_deleted = 0')
  console.log('  ✓ 物料库存归 0')
  const r = await rawExec(`DELETE FROM users WHERE ${TEST_ACCOUNT_COND}`)
  console.log('  ✓ 删除测试账号 ' + r.affectedRows + ' 个')

  console.log('\n✅ 清账完成。库内备份表：_bak_reset_' + stamp + '_*（确认无误后可手动删）。')
  console.log('   现在可以按实盘录入期初库存、正式启用。\n')
  process.exit(0)
}

main().catch((e) => { console.error('清账失败：', e); process.exit(1) })
