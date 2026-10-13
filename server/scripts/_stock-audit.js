/**
 * 库存现状只读体检（临时探针脚本，不入库）
 * 目的：搞清「1919 条里 1906 条被标预警」的真实原因，为模拟数据方案提供依据
 * 只读，不做任何写入
 */
require('../src/config/env')
const { query, queryOne } = require('../src/db/pool')

async function main() {
  console.log('='.repeat(70))
  console.log('  库存现状只读体检')
  console.log('='.repeat(70))

  const total = await queryOne('SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0')
  console.log(`\n[1] 物料总数（未删除）：${total.c}`)

  const byWh = await query(
    `SELECT m.warehouse_id, w.name AS warehouse_name, COUNT(*) AS c
       FROM materials m LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.is_deleted = 0 GROUP BY m.warehouse_id, w.name ORDER BY m.warehouse_id`
  )
  console.log('\n[2] 按仓库分布：')
  for (const r of byWh) console.log(`   仓库 ${r.warehouse_id} ${r.warehouse_name || '(无)'} : ${r.c} 条`)

  const ws = await queryOne(
    `SELECT
        SUM(CASE WHEN warning_stock > 0 THEN 1 ELSE 0 END) AS has_warning,
        SUM(CASE WHEN warning_stock = 0 THEN 1 ELSE 0 END) AS zero_warning,
        SUM(CASE WHEN warning_stock IS NULL THEN 1 ELSE 0 END) AS null_warning,
        SUM(CASE WHEN warning_stock > 0 AND current_stock < warning_stock THEN 1 ELSE 0 END) AS alarming,
        SUM(CASE WHEN current_stock = 0 THEN 1 ELSE 0 END) AS stock_zero,
        SUM(CASE WHEN current_stock > 0 THEN 1 ELSE 0 END) AS stock_positive,
        AVG(warning_stock) AS avg_warning,
        AVG(current_stock) AS avg_stock
       FROM materials WHERE is_deleted = 0`
  )
  console.log('\n[3] 预警阈值与库存：')
  console.log(`   阈值 > 0 的物料        ：${ws.has_warning}`)
  console.log(`   阈值为 0 的物料        ：${ws.zero_warning}`)
  console.log(`   阈值为 NULL 的物料     ：${ws.null_warning}`)
  console.log(`   命中预警(库存<阈值)    ：${ws.alarming}`)
  console.log(`   库存为 0 的物料        ：${ws.stock_zero}`)
  console.log(`   库存 > 0 的物料        ：${ws.stock_positive}`)
  console.log(`   平均阈值 / 平均库存    ：${Number(ws.avg_warning).toFixed(2)} / ${Number(ws.avg_stock).toFixed(2)}`)

  const logged = await queryOne(
    `SELECT COUNT(DISTINCT l.material_id) AS c FROM stock_logs l
       JOIN materials m ON m.id = l.material_id WHERE m.is_deleted = 0`
  )
  console.log(`\n[4] 有出入库流水的物料：${logged.c} 条（其余为纯档案，从未动过）`)

  const logsTotal = await queryOne('SELECT COUNT(*) AS c FROM stock_logs')
  const logsToday = await queryOne(
    'SELECT COUNT(*) AS c FROM stock_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)'
  )
  console.log(`    流水总条数：${logsTotal.c}，近 24 小时：${logsToday.c}`)

  console.log('\n[5] 抽样 12 条物料（看清单价/库存/阈值是否像真实数据）：')
  const sample = await query(
    `SELECT id, name, warehouse_id, unit, current_stock, warning_stock, avg_cost, created_at
       FROM materials WHERE is_deleted = 0 ORDER BY id LIMIT 12`
  )
  console.log('   id | 仓库 | 名称 | 库存 | 阈值 | 均价 | 建档时间')
  for (const r of sample) {
    console.log(
      `   ${r.id} | ${r.warehouse_id} | ${String(r.name).slice(0, 18)} | ${r.current_stock} | ` +
      `${r.warning_stock} | ${r.avg_cost} | ${r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '-'}`
    )
  }

  console.log('\n[6] 最近建档的 5 条（看数据是什么时候灌进去的）：')
  const recent = await query(
    `SELECT id, name, warehouse_id, current_stock, warning_stock, created_at
       FROM materials WHERE is_deleted = 0 ORDER BY id DESC LIMIT 5`
  )
  for (const r of recent) {
    console.log(`   ${r.id} | 仓库${r.warehouse_id} | ${String(r.name).slice(0, 20)} | 库存${r.current_stock} | ${r.created_at}`)
  }

  console.log('\n' + '='.repeat(70))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
