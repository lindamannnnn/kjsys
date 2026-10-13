/**
 * 迁移：采购「到货即入账」——加两列
 *
 * 背景（2026-10-09 老板拍板）：
 *   原流程是「点『到货』只登记数量 → 再点『入库』才加库存」，货已进仓库但库存不动，
 *   与实际不符。改为**点『到货』当场把库存加上**（分次到货按增量累加）。
 *
 * 为此需要记住「这条明细已经入账了多少」，否则分次到货算不出增量：
 *   1) purchase_task_items.stocked_qty  该明细累计已入账数量
 *   2) inbound_orders.source_item_id    这张入库单是哪条采购明细生成的
 *      （到货数量改小时要按差额冲销，必须能精确找回自己的入库单）
 *
 * 幂等：已存在则跳过。改表前先备份两张表（项目纪律：动结构先备份）。
 */
require('../config/env')
const { query, queryOne, execute } = require('./pool')

async function hasCol(table, name) {
  const r = await queryOne(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
  return Number(r.c) > 0
}

async function backup(table) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const bak = `_bak_${stamp}_${table}`
  const exists = await queryOne(
    `SELECT COUNT(*) c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [bak])
  if (Number(exists.c) > 0) return bak + '（已存在，跳过）'
  await execute(`CREATE TABLE \`${bak}\` AS SELECT * FROM \`${table}\``)
  const cnt = await queryOne(`SELECT COUNT(*) c FROM \`${bak}\``)
  return `${bak}（备份 ${cnt.c} 行）`
}

async function main() {
  console.log('备份：')
  console.log('  ' + await backup('purchase_task_items'))
  console.log('  ' + await backup('inbound_orders'))

  console.log('加列：')
  if (!(await hasCol('purchase_task_items', 'stocked_qty'))) {
    await execute(`ALTER TABLE purchase_task_items
      ADD COLUMN stocked_qty DECIMAL(12,2) NOT NULL DEFAULT 0
      COMMENT '该明细累计已入账数量（到货即入库存）' AFTER received_qty`)
    console.log('  + purchase_task_items.stocked_qty')
  } else {
    console.log('  = purchase_task_items.stocked_qty 已存在')
  }

  if (!(await hasCol('inbound_orders', 'source_item_id'))) {
    await execute(`ALTER TABLE inbound_orders
      ADD COLUMN source_item_id BIGINT UNSIGNED NOT NULL DEFAULT 0
      COMMENT '来源采购明细 purchase_task_items.id（0=非采购分批到货）' AFTER type`)
    await execute('ALTER TABLE inbound_orders ADD INDEX idx_source_item (source_item_id)')
    console.log('  + inbound_orders.source_item_id（含索引）')
  } else {
    console.log('  = inbound_orders.source_item_id 已存在')
  }

  // 历史数据兜底：已入库(stocked)的明细，把已入账数量补齐成实到数量
  const fixed = await execute(
    `UPDATE purchase_task_items SET stocked_qty = received_qty
      WHERE receive_status = 'stocked' AND stocked_qty = 0 AND received_qty > 0`)
  if (fixed.affectedRows) console.log(`  ~ 回填 stocked_qty：${fixed.affectedRows} 行（历史已入库明细）`)

  const rows = await query(
    `SELECT receive_status, COUNT(*) c, SUM(stocked_qty) s
       FROM purchase_task_items GROUP BY receive_status`)
  console.log('当前明细分布：', JSON.stringify(rows))
  console.log('迁移完成')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
