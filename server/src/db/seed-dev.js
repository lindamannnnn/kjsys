/**
 * ============================================================
 * 创建「小程序开发模式」用的测试身份
 * ------------------------------------------------------------
 * 背景：
 *   小程序 src/utils/cloud.js 里 DEV_MODE = true 时，
 *   不调微信接口，而是用 dev_openid 直接登录。
 *   后端遇到没见过的 openid 会自动建档，但角色为空、状态是 pending，
 *   于是进去以后什么都看不到 —— 模拟器"能启动"但"不能用"。
 *
 *   本脚本预先把这些开发身份建好、给足角色与仓库范围。
 *
 * 用法：npm run seed:dev
 * 幂等：已存在则把角色/仓库/状态同步成脚本里的值
 *
 * ⚠️ 生产环境务必：
 *   1. 把 server/.env 的 ALLOW_DEV_LOGIN 改成 false
 *   2. 用 npm run audit:data 检查，把这些 dev_ 账号删掉
 * ============================================================
 */
require('../config/env')

const { pool, queryOne, execute } = require('./pool')

/* 开发身份清单：openid → 角色 + 可管仓库 */
const DEV_USERS = [
  {
    openid: 'dev_worker_01',
    real_name: '开发·全能',
    roles: ['out', 'in', 'storekeeper', 'purchase'],
    warehouse_ids: [1, 2]
  },
  {
    openid: 'dev_out',
    real_name: '开发·出库员',
    roles: ['out'],
    warehouse_ids: [1]
  },
  {
    openid: 'dev_in',
    real_name: '开发·入库员',
    roles: ['in'],
    warehouse_ids: [1]
  },
  {
    openid: 'dev_sk',
    real_name: '开发·仓管',
    roles: ['storekeeper'],
    warehouse_ids: [1]
  },
  {
    openid: 'dev_purchase',
    real_name: '开发·采购',
    roles: ['purchase'],
    warehouse_ids: [1]
  },
  {
    openid: 'dev_boss',
    real_name: '开发·老板',
    roles: ['boss'],
    warehouse_ids: [1, 2]
  }
]

async function main() {
  console.log('==============================================')
  console.log('  胜龙进销存 · 创建小程序开发身份')
  console.log('==============================================')

  // 前置：确认允许开发登录，否则建了也登不进去
  const allowDev = String(process.env.ALLOW_DEV_LOGIN || '').toLowerCase() === 'true'
  if (!allowDev) {
    console.log('⚠️  server/.env 里 ALLOW_DEV_LOGIN 不是 true ——')
    console.log('    小程序用 dev_openid 登录会被后端拒绝。请先打开该开关。')
    console.log('')
  }

  // 仓库是否存在（不存在说明还没跑 db:seed）
  const wh = await queryOne(
    'SELECT COUNT(*) AS c FROM warehouses WHERE is_deleted = 0'
  )
  if (!wh || !wh.c) {
    console.error('✗ 还没有仓库数据，请先执行：npm run db:seed')
    await pool.end()
    process.exit(1)
  }

  let created = 0
  let updated = 0

  for (const u of DEV_USERS) {
    const rolesJson = JSON.stringify(u.roles)
    const whJson = JSON.stringify(u.warehouse_ids)

    const exist = await queryOne(
      'SELECT id FROM users WHERE openid = ? LIMIT 1',
      [u.openid]
    )

    if (exist) {
      await execute(
        `UPDATE users
            SET real_name = ?, roles = ?, warehouse_ids = ?, status = 'active',
                must_change_password = 0
          WHERE id = ?`,
        [u.real_name, rolesJson, whJson, exist.id]
      )
      updated++
      console.log(
        `[已存在] ${u.openid.padEnd(14)} → 角色=${u.roles.join(',')} 仓库=${u.warehouse_ids.join(',')}`
      )
    } else {
      await execute(
        `INSERT INTO users
           (openid, nickname, real_name, phone, roles, warehouse_ids,
            status, must_change_password, created_at)
         VALUES (?, ?, ?, '', ?, ?, 'active', 0, NOW())`,
        [u.openid, u.real_name, u.real_name, rolesJson, whJson]
      )
      created++
      console.log(
        `[已创建] ${u.openid.padEnd(14)} → 角色=${u.roles.join(',')} 仓库=${u.warehouse_ids.join(',')}`
      )
    }
  }

  console.log('\n----------------------------------------------')
  console.log(`新建 ${created} 个，同步 ${updated} 个`)
  console.log('----------------------------------------------')
  console.log('小程序里怎么用：')
  console.log('  「我的」页面 → 开发身份 → 切换成想要的角色 → 自动重新登录')
  console.log('')
  console.log('⚠️  上线前必办：')
  console.log('  1. server/.env 里 ALLOW_DEV_LOGIN 改成 false')
  console.log('  2. npm run audit:data 会把这些 dev_ 账号列出来，逐条删掉')
  console.log('')

  await pool.end()
}

main().catch(async (e) => {
  console.error('[错误]', e.message)
  process.exit(1)
})
