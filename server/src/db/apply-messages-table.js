/**
 * 建表：messages 站内消息（流程重构 V2 · P1 消息中心底座）
 * ------------------------------------------------------------
 * 幂等：DDL 用 CREATE TABLE IF NOT EXISTS，可重复执行。
 * 用法：npm run db:apply-messages
 *       （或 node src/db/apply-messages-table.js）
 *
 * 说明：schema.sql 里也加了同一张表的定义（供全新建库使用），
 *       本脚本用于「库已存在、只想补这张表」的升级场景。
 * ============================================================
 */
require('../config/env')

const { pool } = require('./pool')

const DDL = `
CREATE TABLE IF NOT EXISTS \`messages\` (
  \`id\`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`to_openid\`  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '接收人 openid（按人投递）',
  \`type\`       VARCHAR(48)  NOT NULL DEFAULT '' COMMENT '消息类型码，如 outbound_picked',
  \`title\`      VARCHAR(128) NOT NULL DEFAULT '' COMMENT '标题（中文，直接展示）',
  \`content\`    VARCHAR(512) NOT NULL DEFAULT '' COMMENT '正文',
  \`ref_type\`   VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '关联单据类型 outbound / inbound / purchase_task',
  \`ref_id\`     BIGINT UNSIGNED DEFAULT NULL COMMENT '关联单据 id',
  \`ref_no\`     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '关联单号（冗余，列表直接显示，免二次查询）',
  \`is_read\`    TINYINT      NOT NULL DEFAULT 0 COMMENT '0=未读 1=已读',
  \`read_at\`    DATETIME     DEFAULT NULL,
  \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_msg_to\`  (\`to_openid\`, \`is_read\`, \`created_at\`),
  KEY \`idx_msg_ref\` (\`ref_type\`, \`ref_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='站内消息（按人投递）'
`

async function main() {
  console.log('==============================================')
  console.log('  建表：messages 站内消息')
  console.log('==============================================')

  // DDL 不能用预处理语句，走 pool.query
  await pool.query(DDL)
  console.log('\n✅ messages 表已就绪（已存在则跳过）。')

  const [rows] = await pool.query('SHOW TABLES LIKE ?', ['messages'])
  console.log(`   校验：${rows.length ? '表存在 ✓' : '表不存在 ✗'}`)

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
