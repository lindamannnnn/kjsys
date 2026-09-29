/**
 * ============================================================
 * 胜龙进销存 · 上线前数据体检（只读，不改任何数据）
 * ------------------------------------------------------------
 * 用途：部署到服务器前，确认本地库是干净的——
 *   1) 测试单据 / 流水 / 盘点 / 供应商 是否已清空
 *   2) 真实物料的库存与成本是否被污染（必须全 0、1909 条）
 *   3) 界面上不该再出现的测试账号是否还活着
 *
 * 本脚本 **只 SELECT，不 DELETE/UPDATE**，随便跑。
 *
 * 用法：node tests/data-audit.js
 * ============================================================
 */
require('../src/config/env')
const mysql = require('mysql2/promise')

/** 上线前必须删掉的账号（测试期建的岗位账号 + 自动化测试账号） */
const MUST_DELETE_USERNAMES = [
  'AUTOTEST_out', 'AUTOTEST_in', 'AUTOTEST_sk', 'AUTOTEST_purchase',
  'zhangshan', 'lina', 'zhaoliu', 'wangzong'
]

/**
 * 上线前必须删掉的 openid 前缀
 * 这些是「小程序开发身份」（npm run seed:dev 创建），
 * 它们没有 username，靠 openid 登录，所以必须单独按前缀识别。
 * 如果部署时忘了删，配合 ALLOW_DEV_LOGIN 没关就会被人直接登进来。
 */
const MUST_DELETE_OPENID_PREFIXES = ['dev_']

/** 账号的登录标识：优先用户名，其次 openid（开发身份只有 openid） */
function loginId(u) {
  return u.username || u.openid || '#' + u.id
}

/** 是否属于上线前必须删掉的账号 */
function mustDelete(u) {
  if (MUST_DELETE_USERNAMES.includes(u.username)) return true
  const oid = String(u.openid || '')
  return MUST_DELETE_OPENID_PREFIXES.some((p) => oid.startsWith(p))
}

let warnings = 0

function line(label, value, ok) {
  const mark = ok === undefined ? '  ' : ok ? '✓ ' : '✗ '
  if (ok === false) warnings++
  console.log(`  ${mark}${label.padEnd(16)} ${value}`)
}

;(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  })
  const one = async (sql, p = []) => (await c.query(sql, p))[0][0]

  console.log('\n============================================================')
  console.log(`  数据体检 · ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT}`)
  console.log('============================================================')

  console.log('\n【一】业务数据应当为空（测试痕迹）')
  const flows = (await one('SELECT COUNT(*) n FROM stock_logs')).n
  const outs = (await one('SELECT COUNT(*) n FROM outbound_orders')).n
  const ins = (await one('SELECT COUNT(*) n FROM inbound_orders')).n
  const checks = (await one('SELECT COUNT(*) n FROM stock_checks')).n
  const sups = (await one('SELECT COUNT(*) n FROM suppliers')).n
  line('库存流水', flows, flows === 0)
  line('出库单', outs, outs === 0)
  line('入库单', ins, ins === 0)
  line('盘点单', checks, checks === 0)
  line('供应商', sups, sups === 0)

  console.log('\n【二】真实物料不能被污染')
  const mats = (await one('SELECT COUNT(*) n FROM materials WHERE is_deleted = 0')).n
  const nzStock = (await one('SELECT COUNT(*) n FROM materials WHERE is_deleted = 0 AND current_stock <> 0')).n
  const nzCost = (await one('SELECT COUNT(*) n FROM materials WHERE is_deleted = 0 AND avg_cost <> 0')).n
  const fakeMat = (await one(
    "SELECT COUNT(*) n FROM materials WHERE name LIKE '%测试%' OR name LIKE '%契约验证%' OR name LIKE '%验证%'"
  )).n
  line('物料条数', mats, mats >= 1900)
  line('非零库存', nzStock, nzStock === 0)
  line('非零成本', nzCost, nzCost === 0)
  line('残留测试物料', fakeMat, fakeMat === 0)

  console.log('\n【三】账号')
  const [users] = await c.query(
    'SELECT id, username, openid, real_name, roles, status FROM users ORDER BY id'
  )
  line('账号总数', users.length)
  const killers = users.filter(mustDelete)
  line(
    '上线前需删除',
    `${killers.length} 个（${killers.map(loginId).join(', ') || '无'}）`,
    killers.length === 0
  )

  console.log('\n  全部账号：')
  for (const u of users) {
    const roles = Array.isArray(u.roles) ? u.roles.join(',') : String(u.roles || '')
    const flag = mustDelete(u) ? ' ← 待删' : ''
    console.log(
      `    #${u.id}  ${loginId(u).padEnd(20)} ${String(u.real_name || '').padEnd(8)} [${roles}] ${u.status}${flag}`
    )
  }

  console.log('\n【四】上线前必须手工确认的两件事（脚本查不了）')
  console.log('    1) 初始管理员密码已改掉（不能还是 admin123456）')
  console.log('    2) 服务器的 JWT_SECRET 已换成随机串（见 deploy/ 与 DEPLOY-GUIDE.md）')

  console.log('\n============================================================')
  if (warnings === 0) {
    console.log('  体检通过：库里没有测试痕迹，可以部署')
  } else {
    console.log(`  体检发现 ${warnings} 项需要处理（见上面 ✗）`)
  }
  console.log('============================================================\n')

  await c.end()
  process.exit(0)
})().catch((e) => {
  console.error('体检失败:', e.message)
  process.exit(1)
})
