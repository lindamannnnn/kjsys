/**
 * 初始化基础数据：两个仓库、系统配置、初始管理员
 * 用法：npm run db:seed
 * 幂等：重复执行不会重复插入
 */
require('../config/env')

const bcrypt = require('bcryptjs')
const { pool, query, queryOne, execute } = require('./pool')

const WAREHOUSES = [
  { code: 'peijian', name: '配件仓', sort_order: 1 },
  { code: 'chengpin', name: '成品仓', sort_order: 2 }
]

async function main() {
  console.log('==============================================')
  console.log('  胜龙进销存 · 初始化基础数据')
  console.log('==============================================')

  // ---------- 1. 仓库 ----------
  for (const w of WAREHOUSES) {
    const exist = await queryOne('SELECT id FROM warehouses WHERE code = ?', [w.code])
    if (exist) {
      console.log(`[仓库] 已存在：${w.name}（id=${exist.id}）`)
    } else {
      const res = await execute(
        'INSERT INTO warehouses (code, name, sort_order, is_deleted, created_at) VALUES (?, ?, ?, 0, NOW())',
        [w.code, w.name, w.sort_order]
      )
      console.log(`[仓库] 已创建：${w.name}（id=${res.insertId}）`)
    }
  }

  // ---------- 2. 系统配置 ----------
  const settings = await queryOne('SELECT id FROM settings WHERE id = 1')
  if (settings) {
    console.log('[配置] 系统配置已存在，跳过')
  } else {
    await execute(
      `INSERT INTO settings
         (id, company_name, warning_enabled, warning_notify_boss, backup_enabled,
          boss_openids, order_no_prefix_out, order_no_prefix_in)
       VALUES (1, '胜龙', 1, 1, 1, JSON_ARRAY(), 'OUT', 'IN')`
    )
    console.log('[配置] 系统配置已初始化')
  }

  // ---------- 3. 初始管理员 ----------
  const username = process.env.ADMIN_USERNAME || 'admin'
  const password = process.env.ADMIN_PASSWORD || 'admin123456'

  const existAdmin = await queryOne('SELECT id, real_name FROM users WHERE username = ?', [username])
  if (existAdmin) {
    console.log(`[管理员] 账号「${username}」已存在（id=${existAdmin.id}），跳过`)
  } else {
    const hash = await bcrypt.hash(password, 10)
    const res = await execute(
      `INSERT INTO users
         (username, password_hash, real_name, phone, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, '系统管理员', '', ?, JSON_ARRAY(), 'active', 1, NOW())`,
      [username, hash, JSON.stringify(['admin', 'boss'])]
    )
    console.log(`[管理员] 已创建后台管理员：${username} / ${password}（id=${res.insertId}）`)
    console.log('         ⚠️  已标记「必须改密」：首次登录后除改密外其他接口一律拒绝，直到改完密码')
  }

  // ---------- 4. 汇总 ----------
  const whCount = await queryOne('SELECT COUNT(*) AS c FROM warehouses WHERE is_deleted = 0')
  const userCount = await queryOne('SELECT COUNT(*) AS c FROM users')
  const matCount = await queryOne('SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0')

  console.log('\n----------------------------------------------')
  console.log(`仓库：${whCount.c} 个`)
  console.log(`用户：${userCount.c} 个`)
  console.log(`物料：${matCount.c} 条`)
  console.log('----------------------------------------------')
  console.log('下一步：npm run import:materials（导入真实物料数据）')

  await pool.end()
}

main().catch((e) => {
  console.error('[错误]', e.message)
  process.exit(1)
})
