/**
 * 生产冒烟：验证生产库结构是否支撑最新代码（投产前）
 * 逐个调关键接口，任何一个报「Unknown column / doesn't exist」都说明生产库结构没对齐。
 *
 * 用法（推荐：账号密码登录，不依赖 ALLOW_DEV_LOGIN）：
 *   SMOKE_USER=admin SMOKE_PASS=xxx node tests/_smoke-prod.js
 *   或：node tests/_smoke-prod.js <账号> <密码>
 *
 * ⚠️ 为什么不再默认用 dev_openid（2026-10-16 改）：
 *   1. 生产清账时 `dev_*` 测试账号已被删除，用它们登录会**自动建档成无角色的 pending 账号**，
 *      于是所有受权限保护的接口返回 403 —— 看起来像「结构有问题」，其实是权限问题，会误判。
 *   2. 上线前 `ALLOW_DEV_LOGIN` 要关成 false，届时 dev_openid 登录直接失效。
 *   所以默认走 auth.adminLogin（账号密码），只有显式传 --dev 才回退到 dev_openid。
 */
const BASE = process.env.SMOKE_BASE || 'https://sl.ekkosys.cn'

async function call(name, action, data = {}, token = '') {
  const res = await fetch(`${BASE}/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, data })
  })
  return res.json()
}

async function main() {
  const useDev = process.argv.includes('--dev')
  const user = process.env.SMOKE_USER || process.argv[2] || ''
  const pass = process.env.SMOKE_PASS || process.argv[3] || ''

  console.log('=== 生产冒烟（' + BASE + '）===\n')

  let login, who
  if (!useDev && user && pass && !user.startsWith('--')) {
    login = await call('auth', 'adminLogin', { username: user, password: pass })
    who = `账号密码登录（${user}）`
  } else {
    login = await call('auth', 'login', { dev_openid: 'dev_boss' })
    who = 'dev_openid 开发登录（dev_boss）'
  }

  if (!login.data || !login.data.token) {
    console.log('❌ 登录失败：', login.message)
    if (!useDev && !(user && pass)) {
      console.log('   提示：请用 SMOKE_USER=账号 SMOKE_PASS=密码 传入一个有管理员权限的账号。')
    }
    process.exit(1)
  }
  const tok = login.data.token
  const roles = login.data.roles || []
  console.log(`✓ 登录成功（${who}），角色 = [${roles.join(', ') || '空'}]`)
  if (!roles.length) {
    console.log('⚠️  这个账号没有任何角色 → 下面受权限保护的接口会返回 403。')
    console.log('   那属于「权限没配」，不是「生产库结构不对」，别误判成结构问题。')
  }

  const checks = [
    ['stats', 'overview', {}],
    ['stats', 'monthly', { warehouse_id: 2, month: '2026-10' }],
    ['stats', 'stockList', { page: 1, pageSize: 5, warehouse_id: 1 }],
    ['stats', 'warehouseSummary', {}],
    ['material', 'list', { page: 1, pageSize: 5 }],
    ['check', 'list', { page: 1, pageSize: 5 }],
    ['purchase', 'list', { page: 1, pageSize: 5 }],
    ['inbound', 'list', { page: 1, pageSize: 5 }],
    ['outbound', 'list', { page: 1, pageSize: 5 }]
  ]
  let okN = 0, failN = 0, permN = 0
  for (const [m, a, d] of checks) {
    const r = await call(m, a, d, tok)
    const bad = /Unknown column|doesn't exist|no such|ER_/i.test(r.message || '')
    if (r.code === 0) { okN++; console.log(`  ✅ ${m}.${a}`) }
    else if (bad) { failN++; console.log(`  ❌ ${m}.${a}  ← 结构问题：${r.message}`) }
    else if (r.code === 403) { permN++; console.log(`  🔒 ${m}.${a}  ← 403 无权限（不是结构问题）`) }
    else { failN++; console.log(`  ⚠️ ${m}.${a}  ← code=${r.code} ${r.message || ''}`) }
  }
  console.log(`\n结果：${okN} 通过 / ${failN} 失败${permN ? ` / ${permN} 无权限` : ''}`)
  // 只有「结构问题」和非 403 的异常才算失败
  process.exit(failN ? 1 : 0)
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
