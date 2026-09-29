/**
 * 数据核对：导入后确认关键数据正确
 * 用法：npm run verify
 */
require('../config/env')

const { pool, query, queryOne } = require('./pool')

function line(title) {
  console.log('\n----------------------------------------------')
  console.log(`  ${title}`)
  console.log('----------------------------------------------')
}

function pass(ok, msg) {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  return ok
}

async function main() {
  console.log('==============================================')
  console.log('  胜龙进销存 · 数据核对')
  console.log('==============================================')

  let allPass = true

  // ---------- 1. 表完整性 ----------
  line('1. 数据表')
  const tables = await query('SHOW TABLES')
  const names = tables.map((t) => Object.values(t)[0])
  allPass = pass(names.length === 13, `数据表数量：${names.length} / 13`) && allPass

  // ---------- 2. 仓库 ----------
  line('2. 仓库')
  const whs = await query('SELECT id, code, name FROM warehouses WHERE is_deleted = 0 ORDER BY id')
  for (const w of whs) {
    console.log(`   id=${w.id}  code=${w.code}  name=${w.name}`)
  }
  allPass = pass(whs.length >= 2, `仓库数量：${whs.length}（期望 ≥2）`) && allPass

  // ---------- 3. 物料 ----------
  line('3. 物料数据')
  const byWh = await query(
    `SELECT w.code, w.name, COUNT(*) AS c, COALESCE(SUM(m.current_stock),0) AS stock,
            COALESCE(SUM(m.current_stock * m.avg_cost),0) AS value
       FROM materials m JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.is_deleted = 0
      GROUP BY w.id, w.code, w.name ORDER BY w.id`
  )
  let total = 0
  for (const r of byWh) {
    total += Number(r.c)
    console.log(`   ${r.name}（${r.code}）：${r.c} 条，库存 ${r.stock}，库存价值 ¥${Number(r.value).toFixed(2)}`)
  }
  // 源数据（materials-init.json）共 1930 行，其中 20 组同名同规格重复（21 条冗余），
  // 导入时已自动去重，因此库内应为 1909 条
  allPass = pass(total === 1909, `物料总数：${total}（源数据 1930 行 − 去重 21 条 = 1909）`) && allPass

  const chengpin = byWh.find((r) => r.code === 'chengpin')
  const peijian = byWh.find((r) => r.code === 'peijian')
  allPass = pass(Number(chengpin?.c) === 150, `成品仓：${chengpin?.c} 条（期望 150）`) && allPass
  allPass = pass(Number(peijian?.c) === 1759, `配件仓：${peijian?.c} 条（源 1780 行 − 去重 21 条 = 1759）`) && allPass

  // 重复检查
  const dup = await query(
    `SELECT name, spec, warehouse_id, COUNT(*) AS c
       FROM materials WHERE is_deleted = 0
      GROUP BY name, spec, warehouse_id HAVING c > 1 LIMIT 10`
  )
  allPass = pass(dup.length === 0, `重复物料：${dup.length} 组（期望 0）`) && allPass
  if (dup.length) {
    dup.forEach((d) => console.log(`      重复：${d.name} / ${d.spec} × ${d.c}`))
  }

  // ---------- 4. 用户 ----------
  line('4. 用户账号')
  const users = await query('SELECT id, username, real_name, roles, status FROM users ORDER BY id')
  for (const u of users) {
    console.log(`   id=${u.id} ${u.username || '(小程序用户)'} ${u.real_name} 角色=${u.roles} 状态=${u.status}`)
  }
  const admin = users.find((u) => u.username === 'admin')
  allPass = pass(!!admin, `后台管理员账号：${admin ? '已创建' : '缺失'}`) && allPass
  allPass = pass(users.every((u) => u.roles !== null), '所有用户 roles 字段正常（非 null）') && allPass

  // ---------- 5. 业务表状态 ----------
  line('5. 业务数据')
  const counts = {}
  for (const t of ['outbound_orders', 'outbound_order_items', 'inbound_orders', 'inbound_order_items',
    'stock_checks', 'stock_check_items', 'stock_logs', 'operation_logs', 'suppliers']) {
    const r = await queryOne(`SELECT COUNT(*) AS c FROM \`${t}\``)
    counts[t] = Number(r.c)
    console.log(`   ${t.padEnd(24)} ${String(r.c).padStart(6)} 行`)
  }
  console.log('\n   说明：业务表为空是正常的（尚未开始录入单据）')

  // ---------- 6. 索引检查 ----------
  line('6. 关键索引')
  const idx = await query(
    `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND INDEX_NAME IN ('uk_out_client_id','uk_in_client_id','uk_out_order_no','uk_in_order_no','idx_log_material','uk_check_material')
      ORDER BY TABLE_NAME, INDEX_NAME`
  )
  const idxNames = [...new Set(idx.map((i) => i.INDEX_NAME))]
  const expectedIdx = ['uk_out_client_id', 'uk_in_client_id', 'uk_out_order_no', 'uk_in_order_no', 'idx_log_material', 'uk_check_material']
  for (const e of expectedIdx) {
    allPass = pass(idxNames.includes(e), `索引 ${e}`) && allPass
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================')
  console.log(allPass ? '  ✓ 全部检查通过，数据就绪' : '  ✗ 存在未通过项，请查看上方明细')
  console.log('==============================================')

  await pool.end()
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error('[错误]', e.message)
  process.exit(1)
})
