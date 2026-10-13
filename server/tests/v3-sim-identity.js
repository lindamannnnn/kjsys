/**
 * V3 模拟身份准备
 * ============================================================
 * 目的：让「本地模拟微信登录」这条路完全可用，不依赖真实微信 code2session。
 *
 * 原理（现成的，不用新造）：
 *   服务端 auth.login 支持 { dev_openid } 直通（需 .env 里 ALLOW_DEV_LOGIN=true）
 *   小程序侧 DEV_IDENTITIES 提供 5 个可选身份，开发构建里能一键切换
 *
 * 本脚本只做一件事：把 dev 账号的角色 / 仓库数据权限对齐 V2 岗位设置，
 *   使「模拟身份」下的权限与真实微信登录完全一致（否则测出来的权限结论是假的）。
 *
 * 对齐点：
 *   dev_sk       管 配件仓 + 成品仓（用户明确：两个仓同一个仓管员）
 *   dev_purchase 跨仓采购（[1,2]）
 *   dev_in       角色名 'in' 已不在 VALID_ROLES（V2 入库员并入仓管员）→ 停用
 *
 * 用法：
 *   node tests/v3-sim-identity.js            # 预演，只打印不改
 *   node tests/v3-sim-identity.js --apply    # 实际写入
 */
require('../src/config/env')
const { query, queryOne, execute } = require('../src/db/pool')

const APPLY = process.argv.includes('--apply')
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'

// 期望的模拟身份配置（与真实岗位一致）
const TARGETS = [
  { openid: 'dev_worker_01', roles: ['out', 'storekeeper', 'purchase'], warehouse_ids: [1, 2], status: 'active', note: '全能（联调自测用）' },
  { openid: 'dev_out',       roles: ['out'],                            warehouse_ids: [1],    status: 'active', note: '领料员' },
  { openid: 'dev_sk',        roles: ['storekeeper'],                    warehouse_ids: [1, 2], status: 'active', note: '仓管员（配件仓+成品仓）' },
  { openid: 'dev_purchase',  roles: ['purchase'],                       warehouse_ids: [1, 2], status: 'active', note: '采购员' },
  { openid: 'dev_boss',      roles: ['boss'],                           warehouse_ids: [1, 2], status: 'active', note: '老板' },
  { openid: 'dev_in',        roles: ['storekeeper'],                    warehouse_ids: [1],    status: 'disabled', note: 'V2 已废弃（入库员并入仓管员）→ 停用' }
]

/**
 * roles / warehouse_ids 是 MySQL JSON 列，mysql2 驱动会**自动解析成 JS 数组**。
 * 但不同驱动版本 / 直连 SQL 时可能拿到字符串，这里两种都兼容，避免脚本自身报错。
 */
function toArr(v) {
  if (Array.isArray(v)) return v
  if (v === null || v === undefined || v === '') return []
  if (typeof v === 'string') {
    try {
      const j = JSON.parse(v)
      return Array.isArray(j) ? j : []
    } catch {
      return v.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }
  return []
}

const sortedNum = (a) => a.map(Number).sort((x, y) => x - y)

async function loginAs(openid) {
  try {
    const res = await fetch(`${BASE}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', data: { dev_openid: openid, nickname: `模拟·${openid}` } })
    })
    const j = await res.json()
    return j
  } catch (e) {
    return { code: -1, msg: String(e.message || e) }
  }
}

;(async () => {
  console.log('════════ V3 模拟身份准备 ════════')
  console.log(APPLY ? '模式：实际写入' : '模式：预演（加 --apply 才写库）')
  console.log()

  // ---------- 1. 现状 ----------
  console.log('【1】现状')
  const before = await query(
    "SELECT id, openid, roles, warehouse_ids, status FROM users WHERE openid LIKE 'dev\\_%' ORDER BY id"
  )
  if (!before.length) {
    console.log('  ⚠️  库里没有任何 dev_* 账号——模拟登录不可用，请先跑 node src/db/seed-dev.js')
  }
  for (const r of before) {
    console.log(`  ${String(r.openid).padEnd(16)} roles=${String(r.roles).padEnd(34)} wh=${String(r.warehouse_ids).padEnd(8)} ${r.status}`)
  }
  console.log()

  // ---------- 2. 对齐 ----------
  console.log('【2】对齐 V2 岗位')
  for (const t of TARGETS) {
    const row = before.find((r) => r.openid === t.openid)
    if (!row) { console.log(`  ⏭  ${t.openid} 不存在，跳过（要造请跑 seed-dev.js）`); continue }

    const curRoles = toArr(row.roles).slice().sort()
    const curWh = sortedNum(toArr(row.warehouse_ids))
    const wantRoles = t.roles.slice().sort()
    const wantWh = sortedNum(t.warehouse_ids)

    const sameRoles = JSON.stringify(curRoles) === JSON.stringify(wantRoles)
    const sameWh = JSON.stringify(curWh) === JSON.stringify(wantWh)
    const sameStatus = row.status === t.status

    if (sameRoles && sameWh && sameStatus) {
      console.log(`  ✅ ${t.openid.padEnd(16)} 已符合（${t.note}）`)
      continue
    }
    const changes = []
    if (!sameRoles) changes.push(`角色 [${curRoles}] → [${wantRoles}]`)
    if (!sameWh) changes.push(`仓库 [${curWh}] → [${wantWh}]`)
    if (!sameStatus) changes.push(`状态 ${row.status} → ${t.status}`)
    console.log(`  ✏️  ${t.openid.padEnd(16)} ${changes.join(' / ')}   （${t.note}）`)

    if (APPLY) {
      await execute(
        'UPDATE users SET roles = ?, warehouse_ids = ?, status = ? WHERE openid = ?',
        [JSON.stringify(t.roles), JSON.stringify(t.warehouse_ids), t.status, t.openid]
      )
    }
  }
  console.log()

  // ---------- 3. 模拟登录实测 ----------
  console.log('【3】模拟登录实测（真实 HTTP，不接微信）')
  for (const t of TARGETS) {
    if (t.status === 'disabled') { console.log(`  —  ${t.openid.padEnd(16)} 已停用，跳过验证`); continue }
    const j = await loginAs(t.openid)
    if (j.code !== 0) {
      console.log(`  ❌ ${t.openid.padEnd(16)} 登录失败：${j.msg || JSON.stringify(j)}`)
      continue
    }
    const d = j.data || {}
    const roles = JSON.stringify(d.roles || [])
    const flags = [
      d.token ? 'token✓' : 'token✗',
      d.isNew ? 'wx:新用户' : 'wx:老用户',
      d.needRegister ? '待完善资料' : '资料齐'
    ].join(' ')
    console.log(`  ✅ ${t.openid.padEnd(16)} roles=${roles.padEnd(30)} ${flags}`)
  }
  console.log()

  // ---------- 4. 数据权限实测 ----------
  console.log('【4】仓库数据权限实测（决定「能看到哪些仓」）')
  for (const openid of ['dev_sk', 'dev_purchase', 'dev_out', 'dev_boss']) {
    const j = await loginAs(openid)
    if (j.code !== 0) { console.log(`  ❌ ${openid} 无法登录`); continue }
    const token = j.data.token
    const res = await fetch(`${BASE}/api/warehouse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'list', data: {} })
    })
  const w = await res.json()
  const list = (w.data && (w.data.list || w.data)) || []
  const names = Array.isArray(list)
    ? list.map((x) => `${x._id ?? x.id}:${x.name}`).join(', ')
    : JSON.stringify(w.data)
  console.log(`  ${openid.padEnd(16)} 可见仓库 → ${names || '(空)'}`)
  }
  console.log()

  console.log('════════ 完成 ════════')
  if (!APPLY) console.log('（预演模式，未写库。确认无误后加 --apply）')
  process.exit(0)
})().catch((e) => { console.error('脚本异常：', e); process.exit(1) })
