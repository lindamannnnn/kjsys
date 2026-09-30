/**
 * ============================================================
 * 4 角色功能审核 · 清理脚本（服务器版）
 * ------------------------------------------------------------
 * 把审核测试产生的所有痕迹清掉，让系统回到「测试前」状态。
 *
 * 测试前基线（2026-10-01 实测）：
 *   materials = 1906 条真实物料，库存/成本全 0，无【测试】物料
 *   outbound_orders / inbound_orders / stock_logs / stock_checks / suppliers = 0 行
 *
 * 安全护栏（任一不满足就中止，不删任何东西）：
 *   1. 真实物料（非【测试】开头）库存与成本必须全为 0
 *   2. 真实物料不得有库存流水
 *
 * 用法（在服务器 /opt/shenglong/server 下）：
 *   node tests/audit-cleanup.js
 * ============================================================ */
require('../src/config/env')

const { pool, query, execute, withTransaction } = require('../src/db/pool')

const PRE = '【测试】'

async function main() {
  console.log('='.repeat(64))
  console.log('  4 角色功能审核 · 清理')
  console.log('='.repeat(64))

  // ---------- 护栏：确认真实数据没被碰过 ----------
  const real = await query(
    `SELECT COUNT(*) AS c FROM materials
      WHERE is_deleted = 0 AND name NOT LIKE ? AND (current_stock <> 0 OR avg_cost <> 0)`,
    [`${PRE}%`]
  )
  if (real[0].c > 0) {
    console.error(`\n[中止] 有 ${real[0].c} 条真实物料的库存/成本不为 0，说明测试污染了真实数据。`)
    console.error('       为避免误删，脚本不做任何清理，请先人工核对。')
    const bad = await query(
      `SELECT id, name, spec, current_stock, avg_cost FROM materials
        WHERE is_deleted = 0 AND name NOT LIKE ? AND (current_stock <> 0 OR avg_cost <> 0) LIMIT 20`,
      [`${PRE}%`]
    )
    bad.forEach((m) => console.error(`       被污染：id=${m.id} ${m.name} 库存=${m.current_stock} 成本=${m.avg_cost}`))
    process.exit(1)
  }

  const realLogs = await query(
    `SELECT COUNT(*) AS c FROM stock_logs l JOIN materials m ON m.id = l.material_id
      WHERE m.name NOT LIKE ?`,
    [`${PRE}%`]
  )
  if (realLogs[0].c > 0) {
    console.error(`\n[中止] 真实物料存在 ${realLogs[0].c} 条库存流水，脚本不做清理。`)
    const bad = await query(
      `SELECT l.id, m.name, l.change_type, l.quantity FROM stock_logs l
         JOIN materials m ON m.id = l.material_id
        WHERE m.name NOT LIKE ? LIMIT 20`,
      [`${PRE}%`]
    )
    bad.forEach((l) => console.error(`       流水：id=${l.id} ${l.name} ${l.change_type} ${l.quantity}`))
    process.exit(1)
  }

  console.log('\n护栏通过：真实物料未被污染（库存全 0，无流水）')

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
    测试物料: (await query('SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?', [`${PRE}%`]))[0].c,
    测试账号: (await query("SELECT COUNT(*) AS c FROM users WHERE username LIKE 'audit\\_%'"))[0].c
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

    // 只删测试供应商，真实供应商（若有）不动
    await execute('DELETE FROM suppliers WHERE name LIKE ?', [`${PRE}%`], conn)

    // 测试物料：物理删除（这些是测试专用，不是真实物料）
    await execute('DELETE FROM materials WHERE name LIKE ?', [`${PRE}%`], conn)

    // 测试账号：删掉，让系统回到干净状态（不含 admin 等真实账号）
    await execute("DELETE FROM users WHERE username LIKE 'audit\\_%'", [], conn)
  })

  console.log('\n清理完成。')

  // ---------- 复核 ----------
  const after = {
    盘点单: (await query('SELECT COUNT(*) AS c FROM stock_checks'))[0].c,
    出库单: (await query('SELECT COUNT(*) AS c FROM outbound_orders'))[0].c,
    入库单: (await query('SELECT COUNT(*) AS c FROM inbound_orders'))[0].c,
    库存流水: (await query('SELECT COUNT(*) AS c FROM stock_logs'))[0].c,
    供应商: (await query('SELECT COUNT(*) AS c FROM suppliers'))[0].c,
    测试物料: (await query('SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?', [`${PRE}%`]))[0].c,
    测试账号: (await query("SELECT COUNT(*) AS c FROM users WHERE username LIKE 'audit\\_%'"))[0].c,
    真实物料: (await query(`SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND name NOT LIKE ?`, [`${PRE}%`]))[0].c,
    真实物料库存非0: (await query(`SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND name NOT LIKE ? AND (current_stock <> 0 OR avg_cost <> 0)`, [`${PRE}%`]))[0].c
  }
  console.log('\n复核结果：')
  let pass = true
  Object.entries(after).forEach(([k, v]) => {
    const expectZero = k !== '真实物料'
    const good = expectZero ? v === 0 : v === 1906
    if (!good) pass = false
    console.log(`  ${good ? '✓' : '✗'} ${k.padEnd(14)} ${v}${expectZero ? '（应为 0）' : '（应为 1906）'}`)
  })

  console.log('\n' + '='.repeat(64))
  console.log(pass ? '  ✓ 系统已回到测试前状态' : '  ✗ 仍有残留，请检查')
  console.log('='.repeat(64))
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('\n[清理失败]', e.message)
    process.exit(1)
  })
