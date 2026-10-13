/**
 * ============================================================
 * V2 修复复验（第二批：盘点审批 + 已完成单作废权限）
 * ------------------------------------------------------------
 * F 盘点审核必须明确表态
 *     修复前：approve 不传 → 默认「通过」；传 "yes" → 也判「通过」
 *     修复后：不传 / 传乱七八糟的值 → 拦下；只有明确 true 才算通过
 *     判据：approve:"yes" 必须被拦（对照：approve:true 必须通过）
 *
 * G 「已完成」单作废只能管理员
 *     修复前：boss 也算 manager → 老板能作废已完成的出库单（会回补库存）
 *     修复后：只有 admin 能作废
 *     判据：boss 作废必须 403（对照：admin 作废必须成功）
 *
 * 用法：node tests/v2-fix-verify2.js
 * ============================================================
 */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const CTX_FILE = path.join(__dirname, 'v2-test-context.json')

function call(moduleName, action, data = {}, token = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ action, data })
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(
      `${BASE}/api/${moduleName}`,
      { method: 'POST', headers, timeout: 20000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (e) {
            reject(new Error(`响应非 JSON：${raw.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
    req.write(payload)
    req.end()
  })
}

const checks = []
function record(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}`)
  console.log(`     ${detail}`)
}

async function main() {
  console.log('='.repeat(66))
  console.log('  V2 修复复验 · 第二批（盘点审批 / 已完成单作废）')
  console.log('='.repeat(66))

  const ctx = JSON.parse(fs.readFileSync(CTX_FILE, 'utf8'))
  const bySpec = {}
  ctx.测试物料.forEach((m) => (bySpec[m.规格] = m))
  const spk = bySpec['TEST-SPK-A']

  const admin = await call('auth', 'adminLogin', { username: 'admin', password: '123456' })
  const wz = await call('auth', 'adminLogin', { username: 'wangzong', password: 'wz123456' })
  const zl = await call('auth', 'adminLogin', { username: 'zhaoliu', password: 'zl123456' })
  if (admin.code !== 0 || wz.code !== 0 || zl.code !== 0) throw new Error('账号登录失败')
  const A = admin.data.token
  const W = wz.data.token
  const Z = zl.data.token

  // ============================================================
  // F. 盘点审核必须明确表态
  // ============================================================
  console.log('\n【F】盘点审核：只认明确的「通过」')

  // 先把历次复验遗留的、未结束的测试盘点单取消掉，
  // 否则同一物料会撞上系统「不能同时挂两张盘点单」的冲突检查（这是对的行为）
  const openChecks = await call('check', 'list', { page: 1, pageSize: 50 }, A)
  for (const c of (openChecks.data && openChecks.data.list) || []) {
    if (/\[VERIFY\]/.test(String(c.remark || '')) && !['completed', 'cancelled'].includes(c.status)) {
      const r = await call('check', 'cancel', { id: c._id }, A)
      console.log(`  · 清理遗留盘点单 ${c._id}（${c.status}）→ ${r.code === 0 ? '已取消' : r.message}`)
    }
  }

  const cur = await call('material', 'detail', { id: spk._id }, A)
  const bookStock = Number((cur.data && cur.data.current_stock) || 0)
  console.log(`  当前【测试】火花塞 A型 库存 = ${bookStock}（实盘填同值，使差异为 0，不动物流账）`)

  const created = await call(
    'check',
    'create',
    {
      warehouse_id: 1,
      type: 'partial',
      scope: { material_ids: [spk._id] },
      remark: '[VERIFY] 盘点审批校验复验'
    },
    Z
  )
  if (created.code !== 0) {
    record('F0 构造盘点单', false, `check.create → code=${created.code} message=${created.message}（该条未能构造场景）`)
  } else {
    const checkId = created.data._id
    await call('check', 'submit', { id: checkId, items: [{ material_id: spk._id, actual_stock: bookStock }] }, Z)

    // 判据要点：修复后 "yes" 不会被当成「通过」，而是按「没明确表态 → 不通过」处理。
    // 所以不能断言「报错」，要断言「它没被判成通过」——表现为走了「退回」分支。
    const bad = await call('check', 'review', { id: checkId, approve: 'yes' }, A)
    const badIsReject = bad.code === 0 && /退回/.test(String(bad.message))
    record(
      'F1 approve 传 "yes" 不会被当成「通过」',
      badIsReject,
      `review(approve:"yes") → code=${bad.code} message=${bad.message}（期望走「退回」分支）`
    )

    // 对照：被退回的单可以重新提交，这次明确传 true，必须能审过
    await call('check', 'submit', { id: checkId, items: [{ material_id: spk._id, actual_stock: bookStock }] }, Z)
    const good = await call('check', 'review', { id: checkId, approve: true }, A)
    record(
      'F2 对照：approve 传 true 必须通过',
      good.code === 0 && !/退回/.test(String(good.message)),
      `review(approve:true) → code=${good.code} message=${good.message}`
    )

    const after = await call('material', 'detail', { id: spk._id }, A)
    record(
      'F3 差异为 0 时库存未被改动',
      Number((after.data && after.data.current_stock) || 0) === bookStock,
      `审核后库存 = ${after.data && after.data.current_stock}（期望 ${bookStock}）`
    )
  }

  // ============================================================
  // G. 已完成单作废权限
  // ============================================================
  console.log('\n【G】「已完成」出库单作废：只有管理员')
  const sub = await call(
    'outbound',
    'submit',
    {
      warehouse_id: 1,
      type: 'baofei',
      remark: '[VERIFY] 作废权限复验',
      items: [{ material_id: spk._id, material_name: spk.名称, material_spec: spk.规格, unit: '个', quantity: 1 }]
    },
    Z
  )
  if (sub.code !== 0) throw new Error(`构造出库单失败：${sub.message}`)
  const oid = sub.data._id
  await call('outbound', 'confirm', { id: oid }, Z)
  await call('outbound', 'pickDone', { id: oid }, Z)
  const rec = await call('outbound', 'receive', { id: oid }, Z)
  const det = await call('outbound', 'detail', { id: oid }, A)
  console.log(`  已构造单据 ${sub.data.order_no}，状态 = ${det.data && det.data.status}（收货：${rec.message}）`)

  const byBoss = await call('outbound', 'cancel', { id: oid, reason: '老板试作废' }, W)
  record(
    'G1 老板作废「已完成」单被拦',
    byBoss.code !== 0,
    `王总 cancel(completed 单) → code=${byBoss.code} message=${byBoss.message}`
  )

  const byAdmin = await call('outbound', 'cancel', { id: oid, reason: '[VERIFY] 复验完毕，管理员作废清理' }, A)
  record(
    'G2 对照：管理员作废必须成功',
    byAdmin.code === 0,
    `管理员 cancel(completed 单) → code=${byAdmin.code} message=${byAdmin.message}`
  )

  const afterStock = await call('material', 'detail', { id: spk._id }, A)
  record(
    'G3 作废后库存已正确回补',
    Number((afterStock.data && afterStock.data.current_stock) || 0) === bookStock,
    `作废后库存 = ${afterStock.data && afterStock.data.current_stock}（应回到 ${bookStock}，即收货扣的 1 个已回补）`
  )

  const failed = checks.filter((c) => !c.pass)
  console.log('\n' + '='.repeat(66))
  console.log(`  复验结果：${checks.length - failed.length}/${checks.length} 通过`)
  console.log('='.repeat(66))
  failed.forEach((f) => console.log(`  ❌ ${f.name}`))

  fs.writeFileSync(
    path.join(__dirname, 'v2-fix-verify2-result.json'),
    JSON.stringify({ 时间: new Date().toISOString(), 通过: checks.length - failed.length, 总数: checks.length, 明细: checks }, null, 2),
    'utf8'
  )
  console.log('')
}

main().catch((e) => {
  console.error('\n[复验失败]', e.message)
  process.exit(1)
})
