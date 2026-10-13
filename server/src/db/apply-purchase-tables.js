/**
 * 建表：purchase_tasks / purchase_task_items（流程重构 V2 · P4 采购线）
 * ------------------------------------------------------------
 * 幂等：DDL 用 CREATE TABLE IF NOT EXISTS，可重复执行。
 * 用法：npm run db:apply-purchase
 *
 * 说明：schema.sql 里也有同一份定义（供全新建库使用），
 *       本脚本用于「库已存在、只想补这两张表」的升级场景。
 * ============================================================
 */
require('../config/env')

const { pool } = require('./pool')

const DDL_TASKS = `
CREATE TABLE IF NOT EXISTS \`purchase_tasks\` (
  \`id\`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`task_no\`              VARCHAR(32)  NOT NULL COMMENT '采购单号 CG-20261003-001',
  \`warehouse_id\`         BIGINT UNSIGNED NOT NULL COMMENT '采购后入哪个仓',
  \`status\`               ENUM('open','taken','purchased','received','cancelled') NOT NULL DEFAULT 'open'
                         COMMENT 'open=待领取 taken=采购中 purchased=已购买待收料 received=已收料入库 cancelled=已取消',
  \`creator_openid\`       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '发起人（仓管）',
  \`creator_name\`         VARCHAR(64)  NOT NULL DEFAULT '',
  \`assignee_openid\`      VARCHAR(64)  DEFAULT NULL COMMENT '指定采购员；为空=全体可领（先到先得）',
  \`assignee_name\`        VARCHAR(64)  DEFAULT NULL,
  \`taker_openid\`         VARCHAR(64)  DEFAULT NULL COMMENT '实际领取人',
  \`taker_name\`           VARCHAR(64)  DEFAULT NULL,
  \`purchase_channel\`     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '购买方式：淘宝/京东/线下/其他',
  \`external_no\`          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '外部订单号（如淘宝单号）',
  \`receipt_fileid\`       VARCHAR(255) NOT NULL DEFAULT '' COMMENT '采购单据附件',
  \`total_amount\`         DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '本次采购总金额（Σ 单价×数量）',
  \`inbound_order_id\`     BIGINT UNSIGNED DEFAULT NULL COMMENT '收货后生成的入库单 id',
  \`inbound_order_no\`     VARCHAR(32)  NOT NULL DEFAULT '',
  \`remark\`               VARCHAR(255) NOT NULL DEFAULT '',
  \`taken_at\`             DATETIME     DEFAULT NULL,
  \`purchased_at\`         DATETIME     DEFAULT NULL,
  \`received_at\`          DATETIME     DEFAULT NULL,
  \`cancelled_at\`         DATETIME     DEFAULT NULL,
  \`cancel_operator_name\` VARCHAR(64)  DEFAULT NULL,
  \`cancel_reason\`        VARCHAR(255) DEFAULT NULL,
  \`reject_reason\`        VARCHAR(255) DEFAULT NULL COMMENT '仓管收料不通过时退回采购员的原因',
  \`client_request_id\`    VARCHAR(64)  DEFAULT NULL COMMENT '幂等键',
  \`is_deleted\`           TINYINT      NOT NULL DEFAULT 0,
  \`created_at\`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_pt_no\`     (\`task_no\`),
  UNIQUE KEY \`uk_pt_client\` (\`client_request_id\`),
  KEY \`idx_pt_status\`   (\`status\`, \`created_at\`),
  KEY \`idx_pt_wh\`       (\`warehouse_id\`, \`created_at\`),
  KEY \`idx_pt_taker\`    (\`taker_openid\`, \`created_at\`),
  KEY \`idx_pt_assignee\` (\`assignee_openid\`, \`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='采购任务'
`

const DDL_ITEMS = `
CREATE TABLE IF NOT EXISTS \`purchase_task_items\` (
  \`id\`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`task_id\`       BIGINT UNSIGNED NOT NULL,
  \`material_id\`   BIGINT UNSIGNED NOT NULL,
  \`material_name\` VARCHAR(191) NOT NULL DEFAULT '',
  \`material_spec\` VARCHAR(191) NOT NULL DEFAULT '',
  \`unit\`          VARCHAR(16)  NOT NULL DEFAULT '',
  \`quantity\`      DECIMAL(14,3) NOT NULL DEFAULT 0,
  \`unit_price\`    DECIMAL(14,4) NOT NULL DEFAULT 0 COMMENT '实际单价（采购员填）',
  \`remark\`        VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (\`id\`),
  KEY \`idx_pti_task\` (\`task_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='采购任务明细'
`

async function main() {
  console.log('==============================================')
  console.log('  建表：采购任务（P4 采购线）')
  console.log('==============================================')

  // DDL 不能用预处理语句，走 pool.query
  await pool.query(DDL_TASKS)
  console.log('\n✅ purchase_tasks 表已就绪（已存在则跳过）。')
  await pool.query(DDL_ITEMS)
  console.log('✅ purchase_task_items 表已就绪（已存在则跳过）。')

  for (const t of ['purchase_tasks', 'purchase_task_items']) {
    const [rows] = await pool.query('SHOW TABLES LIKE ?', [t])
    console.log(`   校验：${t} ${rows.length ? '存在 ✓' : '不存在 ✗'}`)
  }

  await pool.end()
}

main().catch(async (err) => {
  console.error('\n❌ 建表失败：', err && err.message ? err.message : err)
  try {
    await pool.end()
  } catch (e) {
    /* 连接可能已断，忽略 */
  }
  process.exit(1)
})
