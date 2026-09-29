/**
 * ============================================================
 * 管理员密码重置（自救脚本）
 * ------------------------------------------------------------
 * 用途：后台账号忘记密码、或「必须改密」门禁导致进不去时使用。
 *       本脚本直接操作数据库，不依赖登录，因此也是最后的兜底恢复手段。
 *
 * 用法：
 *   node src/db/reset-admin.js                     # 重置为 .env 里的 ADMIN_PASSWORD
 *   node src/db/reset-admin.js NewPass123456       # 指定新密码
 *   node src/db/reset-admin.js --clear-flag        # 只清掉「必须改密」标记（保留原密码）
 * ============================================================
 */
require('../config/env')

const bcrypt = require('bcryptjs')
const { query, queryOne, execute, pool } = require('./pool')

async function main() {
  const args = process.argv.slice(2)
  const clearOnly = args.includes('--clear-flag')
  const custom = args.find((a) => !a.startsWith('--'))

  const username = process.env.ADMIN_USERNAME || 'admin'
  const password = custom || process.env.ADMIN_PASSWORD || 'admin123456'

  const user = await queryOne('SELECT id, username, real_name, roles FROM users WHERE username = ?', [username])
  if (!user) {
    console.error(`[错误] 找不到账号「${username}」`)
    const all = await query('SELECT id, username, real_name FROM users WHERE username IS NOT NULL')
    console.error('       当前可用的后台账号：')
    for (const u of all) console.error(`       - ${u.username}（${u.real_name || '未填姓名'}，id=${u.id}）`)
    await pool.end()
    process.exit(1)
  }

  if (clearOnly) {
    await execute('UPDATE users SET must_change_password = 0 WHERE id = ?', [user.id])
    console.log(`✓ 已清除账号「${username}」的「必须改密」标记（密码未改动）`)
  } else {
    if (String(password).length < 6) {
      console.error('[错误] 密码长度不能少于 6 位')
      await pool.end()
      process.exit(1)
    }
    const hash = await bcrypt.hash(String(password), 10)
    // 同时清掉门禁标记，保证重置后能立刻登录使用
    await execute(
      'UPDATE users SET password_hash = ?, must_change_password = 0, status = ? WHERE id = ?',
      [hash, 'active', user.id]
    )
    console.log('==============================================')
    console.log(`  ✓ 账号「${username}」密码已重置`)
    console.log(`    新密码：${password}`)
    console.log('  角色：' + ((user.roles || []).join('、') || '（无）'))
    console.log('  「必须改密」标记已清除，状态已置为可用')
    console.log('==============================================')
    console.log('  安全提醒：请登录后台后立刻改成只有你知道的强密码')
  }

  await pool.end()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[错误]', e.message)
  try { await pool.end() } catch (_) { /* ignore */ }
  process.exit(1)
})
