/**
 * ============================================================
 * 数据库迁移 v2 —— 4 角色真实使用者测试整改所需字段
 * ------------------------------------------------------------
 * 幂等：先查 information_schema，字段已存在则跳过，可重复执行
 * 用法：npm run db:migrate
 *
 * 新增字段说明（对应报告 4-ROLE-USER-TEST-REPORT.md）：
 *   suppliers.tax_no / payment_terms   供应商税号、账期（P1-10 对账开票必需）
 *   stock_checks.remark                盘点备注（P1-7 传入即丢失）
 *   *.cancel_operator_* / cancel_reason 作废人与原因（P1-2-06 停完看不出是谁停的）
 *   users.must_change_password         强制改密标记（P0-2-02 初始密码可直接登录）
 * ============================================================
 */
require('../config/env')

const { query, execute, pool } = require('./pool')

/** 待新增字段清单：表 → [{ column, ddl }] */
const COLUMNS = [
  { table: 'suppliers', column: 'tax_no', ddl: "ADD COLUMN `tax_no` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '税号/纳税人识别号' AFTER `phone`" },
  { table: 'suppliers', column: 'payment_terms', ddl: "ADD COLUMN `payment_terms` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '账期，如 月结30天' AFTER `tax_no`" },

  { table: 'stock_checks', column: 'remark', ddl: "ADD COLUMN `remark` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '盘点说明' AFTER `scope`" },

  { table: 'outbound_orders', column: 'cancel_operator_openid', ddl: "ADD COLUMN `cancel_operator_openid` VARCHAR(64) DEFAULT NULL COMMENT '作废/撤销人 openid' AFTER `cancelled_at`" },
  { table: 'outbound_orders', column: 'cancel_operator_name', ddl: "ADD COLUMN `cancel_operator_name` VARCHAR(64) DEFAULT NULL COMMENT '作废/撤销人姓名' AFTER `cancel_operator_openid`" },
  { table: 'outbound_orders', column: 'cancel_reason', ddl: "ADD COLUMN `cancel_reason` VARCHAR(255) DEFAULT NULL COMMENT '作废/撤销原因' AFTER `cancel_operator_name`" },

  { table: 'inbound_orders', column: 'cancel_operator_openid', ddl: "ADD COLUMN `cancel_operator_openid` VARCHAR(64) DEFAULT NULL COMMENT '作废/撤销人 openid' AFTER `cancelled_at`" },
  { table: 'inbound_orders', column: 'cancel_operator_name', ddl: "ADD COLUMN `cancel_operator_name` VARCHAR(64) DEFAULT NULL COMMENT '作废/撤销人姓名' AFTER `cancel_operator_openid`" },
  { table: 'inbound_orders', column: 'cancel_reason', ddl: "ADD COLUMN `cancel_reason` VARCHAR(255) DEFAULT NULL COMMENT '作废/撤销原因' AFTER `cancel_operator_name`" },

  { table: 'users', column: 'must_change_password', ddl: "ADD COLUMN `must_change_password` TINYINT NOT NULL DEFAULT 0 COMMENT '1=首次登录必须改密' AFTER `status`" }
]

/** 字段是否已存在 */
async function hasColumn(table, column) {
  const rows = await query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  )
  return Number(rows[0].c) > 0
}

async function main() {
  console.log('==============================================')
  console.log('  胜龙进销存 · 数据库迁移 v2（测试整改字段）')
  console.log('==============================================')

  let added = 0
  let skipped = 0
  let failed = 0

  for (const item of COLUMNS) {
    const exists = await hasColumn(item.table, item.column)
    if (exists) {
      skipped++
      continue
    }
    try {
      await execute(`ALTER TABLE \`${item.table}\` ${item.ddl}`)
      console.log(`  ✓ 新增 ${item.table}.${item.column}`)
      added++
    } catch (e) {
      console.error(`  ✗ 失败 ${item.table}.${item.column}：${e.message}`)
      failed++
    }
  }

  console.log('----------------------------------------------')
  console.log(`  新增 ${added} 项，已存在跳过 ${skipped} 项，失败 ${failed} 项`)

  if (failed) {
    console.error('  存在失败项，请检查后重试')
  } else {
    console.log('  ✓ 迁移完成')
  }
  console.log('==============================================')

  await pool.end()
  process.exit(failed ? 1 : 0)
}

main().catch(async (e) => {
  console.error('[错误]', e.message)
  try { await pool.end() } catch (_) { /* ignore */ }
  process.exit(1)
})
