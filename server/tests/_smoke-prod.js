/**
 * 生产冒烟：验证生产库结构是否支撑最新代码（投产前）
 * 用 dev_openid（生产 ALLOW_DEV_LOGIN 仍 true）登录后，逐个调关键接口，
 * 任何一个报「Unknown column / doesn't exist」都说明生产库结构没对齐。
 * 用法：node tests/_smoke-prod.js
 */
const BASE = 'https://sl.ekkosys.cn'

async function call(name, action, data = {}, token = '') {
  const res = await fetch(`${BASE}/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, data })
  })
  return res.json()
}

async function main() {
  console.log('=== 生产冒烟（' + BASE + '）===\n')
  // 登录（老板，看数最全）
  const login = await call('auth', 'login', { dev_openid: 'dev_boss' })
  if (!login.data || !login.data.token) {
    console.log('❌ 登录失败：', login.message)
    process.exit(1)
  }
  const tok = login.data.token
  console.log('✓ 登录成功（老板）')

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
  let pass = 0, fail = 0
  for (const [m, a, d] of checks) {
    const r = await call(m, a, d, tok)
    const bad = r.code !== 0 && /Unknown column|doesn't exist|no such|ER_/i.test(r.message || '')
    const okCall = r.code === 0
    if (okCall) { pass++; console.log(`  ✅ ${m}.${a}`) }
    else if (bad) { fail++; console.log(`  ❌ ${m}.${a}  ← 结构问题：${r.message}`) }
    else { fail++; console.log(`  ⚠️ ${m}.${a}  ← code=${r.code} ${r.message || ''}`) }
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
