/**
 * 迁移：users 加「企业微信成员 UserID」列（企业微信推送要按它定位到人）
 * 幂等：已存在则跳过。
 */
require('../../src/config/env')
const { queryOne, execute } = require('../../src/db/pool')

async function main() {
  const r = await queryOne(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'wecom_userid'`)
  if (!Number(r.c)) {
    await execute(`ALTER TABLE users ADD COLUMN wecom_userid VARCHAR(64) NOT NULL DEFAULT '' COMMENT '企业微信成员 UserID（企微推送用）' AFTER phone`)
    console.log('+ users.wecom_userid')
  } else {
    console.log('users.wecom_userid 已存在，跳过')
  }
  console.log('迁移完成')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
