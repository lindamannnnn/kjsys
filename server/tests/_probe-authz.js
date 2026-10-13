/**
 * 取证探针：待审核用户 / 被禁用用户 到底能碰到哪些接口
 * 用法：node tests/_probe-authz.js
 */
require('../src/config/env')
const http = require('http')
const { queryOne, execute } = require('../src/db/pool')

const BASE = 'http://127.0.0.1:3000'
const MARK = 'ZPROBE'

function req(pathname, body, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body || {})
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const r = http.request(`${BASE}${pathname}`, { method: 'POST', headers, timeout: 15000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch (e) { resolve({ code: -999, message: raw.slice(0, 120) }) }
      })
    })
    r.on('error', (e) => resolve({ code: -1, message: e.message }))
    r.write(payload)
    r.end()
  })
}
const api = (m, a, d, t) => req(`/api/${m}`, { action: a, data: d }, t)

const PROBES = [
  ['material', 'list', { page: 1, pageSize: 3 }],
  ['material', 'categories', {}],
  ['supplier', 'list', { page: 1, pageSize: 3 }],
  ['supplier', 'search', { keyword: 'a' }],
  ['warehouse', 'list', {}],
  ['stats', 'stockList', { page: 1, pageSize: 3 }],
  ['stats', 'overview', {}],
  ['inbound', 'list', { page: 1, pageSize: 3 }],
  ['outbound', 'list', { page: 1, pageSize: 3 }],
  ['check', 'list', { page: 1, pageSize: 3 }],
  ['user', 'list', { page: 1, pageSize: 3 }],
  ['auth', 'getUserInfo', {}],
  ['auth', 'myLogs', { page: 1, pageSize: 3 }]
]

async function main() {
  // ---------- 造一个待审核用户 ----------
  const pendingOpenid = `${MARK}_pending_${Date.now()}`
  const pendLogin = await api('auth', 'login', { dev_openid: pendingOpenid })
  const pendToken = pendLogin.data?.token
  const pendId = pendLogin.data?.user?._id
  await api('auth', 'register', { real_name: `${MARK}待审`, phone: '13600000009' }, pendToken)

  const row = await queryOne('SELECT id, status, roles FROM users WHERE id = ?', [pendId])
  console.log('='.repeat(70))
  console.log('探针 A：待审核用户（status=%s, roles=%s）能访问哪些接口', row.status, JSON.stringify(row.roles))
  console.log('='.repeat(70))
  const pendHits = []
  for (const [m, a, d] of PROBES) {
    const r = await api(m, a, d, pendToken)
    const allowed = r.code === 0
    if (allowed) pendHits.push(`${m}.${a}`)
    console.log(`  ${allowed ? '⚠ 放行' : '  拦截'}  ${(m + '.' + a).padEnd(26)} code=${String(r.code).padEnd(4)} ${r.message || ''}`)
  }
  console.log(`\n  小结：待审核用户被放行 ${pendHits.length} 个接口`)
  if (pendHits.length) console.log(`        ${pendHits.join(', ')}`)

  // ---------- 造一个被禁用的用户 ----------
  const disabledOpenid = `${MARK}_disabled_${Date.now()}`
  const dLogin = await api('auth', 'login', { dev_openid: disabledOpenid })
  const dId = dLogin.data?.user?._id
  await api('auth', 'register', { real_name: `${MARK}禁用`, phone: '13600000008' }, dLogin.data?.token)
  // 直接置为 active + 给角色，再禁用
  await execute("UPDATE users SET roles = JSON_ARRAY('out'), status = 'disabled' WHERE id = ?", [dId])
  const dRow = await queryOne('SELECT status, roles FROM users WHERE id = ?', [dId])

  const dRelogin = await api('auth', 'login', { dev_openid: disabledOpenid })
  console.log('\n' + '='.repeat(70))
  console.log('探针 B：被禁用用户（status=%s）重新登录', dRow.status)
  console.log('='.repeat(70))
  console.log(`  登录返回 code=${dRelogin.code} message=${dRelogin.message}`)
  console.log(`  登录拿到的角色：${JSON.stringify(dRelogin.data?.roles)}`)
  const dToken = dRelogin.data?.token
  console.log(`  是否签发令牌：${dToken ? '是（危险）' : '否'}`)

  if (dToken) {
    console.log('\n  用这把令牌去调接口：')
    for (const [m, a, d] of PROBES.slice(0, 6)) {
      const r = await api(m, a, d, dToken)
      console.log(`    ${r.code === 0 ? '⚠ 放行' : '  拦截'}  ${(m + '.' + a).padEnd(26)} code=${String(r.code).padEnd(4)} ${r.message || ''}`)
    }
  }

  // ---------- 清理 ----------
  for (const id of [pendId, dId]) {
    if (id) {
      await execute("DELETE FROM operation_logs WHERE target_id = ? AND action IN ('register','login')", [String(id)]).catch(() => {})
      await execute('DELETE FROM users WHERE id = ?', [id]).catch(() => {})
    }
  }
  await execute("DELETE FROM operation_logs WHERE openid LIKE ?", [`${MARK}%`]).catch(() => {})
  console.log('\n  探针数据已清理')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
