/**
 * 迁移：settings 加「期初建账模式」开关列（2026-10-20）
 *
 * 用途：上线后客户需要自己把「数量 + 金额」填进系统。开启这个开关后，
 *   「编辑物料」页才会出现期初数量/期初金额两个字段；填完关掉即可。
 *
 * 幂等：已存在则跳过。
 * 与 schema.sql 必须同步改，否则 `npm run db:check-schema` 会报结构漂移。
 */
require('../../src/config/env')
const { queryOne, execute } = require('../../src/db/pool')

async function main() {
  const r = await queryOne(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'settings' AND COLUMN_NAME = 'opening_mode'`
  )
  if (!Number(r.c)) {
    await execute(
      `ALTER TABLE settings
         ADD COLUMN opening_mode TINYINT NOT NULL DEFAULT 0
         COMMENT '期初建账录入模式：1=开启（编辑物料页可填期初数量与金额），0=关闭'
         AFTER backup_enabled`
    )
    console.log('+ settings.opening_mode')
  } else {
    console.log('settings.opening_mode 已存在，跳过')
  }

  // 兜底：settings 必须存在 id=1 这一行，否则开关无处可存
  const row = await queryOne('SELECT id FROM settings WHERE id = 1')
  if (!row) {
    await execute('INSERT INTO settings (id) VALUES (1)')
    console.log('+ settings 初始化 id=1 行')
  }

  const after = await queryOne('SELECT opening_mode FROM settings WHERE id = 1')
  console.log('当前 opening_mode =', after && after.opening_mode)
  console.log('迁移完成')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
