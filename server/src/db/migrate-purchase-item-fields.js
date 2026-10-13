/**
 * 迁移：purchase_task_items 加「购买方式 / 外部单号」两列
 * 背景：一张采购单里不同物料可能从不同地方买（淘宝/京东/线下混着），
 * 原来只在任务级记一个渠道，对不上账。改为明细级。
 * 幂等：已存在则跳过。
 */
require('../../src/config/env')
const { queryOne, execute } = require('../../src/db/pool')

async function hasCol(name) {
  const r = await queryOne(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_task_items' AND COLUMN_NAME = ?`, [name])
  return Number(r.c) > 0
}

async function main() {
  if (!(await hasCol('purchase_channel'))) {
    await execute(`ALTER TABLE purchase_task_items ADD COLUMN purchase_channel VARCHAR(32) NOT NULL DEFAULT '' COMMENT '该项购买方式（淘宝/京东/线下/其他）' AFTER unit_price`)
    console.log('+ purchase_channel')
  }
  if (!(await hasCol('external_no'))) {
    await execute(`ALTER TABLE purchase_task_items ADD COLUMN external_no VARCHAR(64) NOT NULL DEFAULT '' COMMENT '该项外部单号' AFTER purchase_channel`)
    console.log('+ external_no')
  }
  // 逐项到货确认（V5）：货件不同时到，仓管逐项确认实到数量/退货，全部确认后才整单入库
  if (!(await hasCol('receive_status'))) {
    await execute(`ALTER TABLE purchase_task_items ADD COLUMN receive_status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '到货确认：pending待确认/received已到货/returned已退货' AFTER external_no`)
    console.log('+ receive_status')
  }
  if (!(await hasCol('received_qty'))) {
    await execute(`ALTER TABLE purchase_task_items ADD COLUMN received_qty DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '实到数量' AFTER receive_status`)
    console.log('+ received_qty')
  }
  if (!(await hasCol('return_reason'))) {
    await execute(`ALTER TABLE purchase_task_items ADD COLUMN return_reason VARCHAR(255) NOT NULL DEFAULT '' COMMENT '退货原因' AFTER received_qty`)
    console.log('+ return_reason')
  }
  // 任务状态 ENUM 加 receiving（分批到货的中间态）
  const col = await queryOne(
    `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_tasks' AND COLUMN_NAME = 'status'`)
  if (col && !col.t.includes('receiving')) {
    await execute("ALTER TABLE purchase_tasks MODIFY COLUMN status ENUM('open','taken','purchased','receiving','received','cancelled') NOT NULL DEFAULT 'open'")
    console.log('+ status ENUM receiving')
  }
  console.log('迁移完成')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
