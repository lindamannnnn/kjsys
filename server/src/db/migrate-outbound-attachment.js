/**
 * 迁移：outbound_orders 加「附件」列（报废申请必须上传现场照片）
 * 幂等：已存在则跳过。
 */
require('../../src/config/env')
const { queryOne, execute } = require('../../src/db/pool')

async function main() {
  const r = await queryOne(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'outbound_orders' AND COLUMN_NAME = 'attachment'`)
  if (!Number(r.c)) {
    await execute(`ALTER TABLE outbound_orders ADD COLUMN attachment VARCHAR(255) NOT NULL DEFAULT '' COMMENT '附件（报废现场照片等）' AFTER remark`)
    console.log('+ outbound_orders.attachment')
  }
  console.log('迁移完成')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
