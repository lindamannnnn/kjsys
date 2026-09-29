/**
 * ============================================================
 * 4 角色真实使用者测试 · 清理脚本
 * ------------------------------------------------------------
 * 把测试产生的所有痕迹清掉，让系统回到「测试前」状态。
 *
 * 测试前的基线（见 verify.js 输出）：
 *   stock_checks / stock_check_items / stock_logs / suppliers = 0 行
 *   outbound_orders / inbound_orders 及其明细 = 0 行
 *   materials = 1909 条真实物料，库存全 0
 *
 * 安全护栏（任一不满足就中止，不删任何东西）：
 *   1. 真实物料（非【测试】开头）库存必须全为 0
 *   2. 真实物料不得有库存流水
 *
 * 用法：node tests/user-test-cleanup.js
 * ============================================================ */
require('../src/config/env')

const { pool, query, execute, withTransaction } = require('../src/db/pool')

const PRE = '【测试】'

async function main() {
  console.log('='.repeat(62))
  console.log('  4 角色真实使用者测试 · 清理')
  console.log('='.repeat(62))

  // ---------- 护栏：确认真实数据没被碰过 ----------
  const real = await query(
    `SELECT COUNT(*) AS c FROM materials
      WHERE is_deleted = 0 AND name NOT LIKE ? AND (current_stock <> 0 OR avg_cost <> 0)`,
    [`${PRE}%`]
  )
  if (real[0].c > 0) {
    console.error(`\n[中止] 有 ${real[0].c} 条真实物料的库存/成本不为 0，说明测试污染了真实数据。`)
    console.error('       为避免误删，脚本不做任何清理，请先人工核对。')
    process.exit(1)
  }

  const realLogs = await query(
    `SELECT COUNT(*) AS c FROM stock_logs l JOIN materials m ON m.id = l.material_id
      WHERE m.name NOT LIKE ?`,
    [`${PRE}%`]
  )
  if (realLogs[0].c > 0) {
    console.error(`\n[中止] 真实物料存在 ${realLogs[0].c} 条库存流水，脚本不做清理。`)
    process.exit(1)
  }

  console.log('\n护栏通过：真实物料未被污染（1909 条，库存全 0，无流水）')

  // ---------- 统计待清理数据 ----------
  const counts = {
    盘点单: (await query('SELECT COUNT(*) AS c FROM stock_checks'))[0].c,
    盘点明细: (await query('SELECT COUNT(*) AS c FROM stock_check_items'))[0].c,
    出库单: (await query('SELECT COUNT(*) AS c FROM outbound_orders'))[0].c,
    出库明细: (await query('SELECT COUNT(*) AS c FROM outbound_order_items'))[0].c,
    入库单: (await query('SELECT COUNT(*) AS c FROM inbound_orders'))[0].c,
    入库明细: (await query('SELECT COUNT(*) AS c FROM inbound_order_items'))[0].c,
    库存流水: (await query('SELECT COUNT(*) AS c FROM stock_logs'))[0].c,
    供应商: (await query('SELECT COUNT(*) AS c FROM suppliers'))[0].c,
    测试物料: (await query(`SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?`, [`${PRE}%`]))[0].c
  }
  console.log('\n待清理：')
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(8)} ${v}`))

  // ---------- 执行清理 ----------
  await withTransaction(async (conn) => {
    // 明细先删（有外键/依赖），再删主单
    await execute('DELETE FROM stock_check_items', [], conn)
    await execute('DELETE FROM stock_checks', [], conn)
    await execute('DELETE FROM outbound_order_items', [], conn)
    await execute('DELETE FROM outbound_orders', [], conn)
    await execute('DELETE FROM inbound_order_items', [], conn)
    await execute('DELETE FROM inbound_orders', [], conn)
    await execute('DELETE FROM stock_logs', [], conn)
    await execute('DELETE FROM suppliers', [], conn)

    // 测试物料：物理删除（这些是测试专用，不是真实物料）
    await execute('DELETE FROM materials WHERE name LIKE ?', [`${PRE}%`], conn)
  })

  console.log('\n清理完成。')

  // ---------- 复核 ----------
  const after = {
    盘点单: (await query('SELECT COUNT(*) AS c FROM stock_checks'))[0].c,
    出库单: (await query('SELECT COUNT(*) AS c FROM outbound_orders'))[0].c,
    入库单: (await query('SELECT COUNT(*) AS c FROM inbound_orders'))[0].c,
    库存流水: (await query('SELECT COUNT(*) AS c FROM stock_logs'))[0].c,
    供应商: (await query('SELECT COUNT(*) AS c FROM suppliers'))[0].c,
    测试物料: (await query(`SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?`, [`${PRE}%`]))[0].c,
    真实物料: (await query(`SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND name NOT LIKE ?`, [`${PRE}%`]))[0].c
  }
  console.log('\n复核结果：')
  let pass = true
  Object.entries(after).forEach(([k, v]) => {
    const expectZero = k !== '真实物料'
    const good = expectZero ? v === 0 : v === 1909
    if (!good) pass = false
    console.log(`  ${good ? '✓' : '✗'} ${k.padEnd(8)} ${v}${expectZero ? '（应为 0）' : '（应为 1909）'}`)
  })

  // 账号与操作日志：测试账号与日志保留，由报告说明
  const users = await query("SELECT username, real_name FROM users ORDER BY id")
  console.log('\n保留的账号（测试期间建立）：')
  users.forEach((u) => console.log(`  ${u.username.padEnd(12)} ${u.real_name}`))

  console.log('\n' + '='.repeat(62))
  console.log(pass ? '  ✓ 系统已回到测试前状态' : '  ✗ 仍有残留，请检查')
  console.log('='.repeat(62))
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('\n[清理失败]', e.message)
    process.exit(1)
  })
