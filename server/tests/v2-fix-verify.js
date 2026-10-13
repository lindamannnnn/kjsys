/**
 * ============================================================
 * V2 修复复验（判据脚本）
 * ------------------------------------------------------------
 * 每条修复都配一个「修复前会错 / 修复后该对」的对照场景，
 * 不是单跑一遍看着像通过就算数。
 *
 * 复验项：
 *   A 采购单价填 0         → 必须被拦（对照：填正常单价必须通过）
 *   B 老板给自己/别人设管理员 → 必须被拦（对照：管理员设必须通过）
 *   C stats.overview       → 必须返回 picking_outbound / receiving_outbound
 *   D 领料员提报废单        → 必须被拦（对照：仓管提报废单必须通过）
 *   E 仓管 myTodoCount      → 必须返回 waiting_receive（不再恒为 0）
 *
 * 用法：node tests/v2-fix-verify.js
 * ============================================================
 */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const CTX_FILE = path.join(__dirname, 'v2-test-context.json')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function call(moduleName, action, data = {}, token = '', clientRequestId = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      action,
      data,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {})
    })
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

async function waitService() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call('warehouse', 'list', {})
      if (r && typeof r.code === 'number') return true
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(500)
  }
  return false
}

async function main() {
  console.log('='.repeat(66))
  console.log('  V2 修复复验（含对照场景）')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(66))

  const up = await waitService()
  if (!up) throw new Error('服务未就绪，无法复验')
  console.log('\n服务就绪。\n')

  const ctx = JSON.parse(fs.readFileSync(CTX_FILE, 'utf8'))
  const bySpec = {}
  ctx.测试物料.forEach((m) => (bySpec[m.规格] = m))
  const spk = bySpec['TEST-SPK-A']

  const admin = await call('auth', 'adminLogin', { username: 'admin', password: '123456' })
  const wz = await call('auth', 'adminLogin', { username: 'wangzong', password: 'wz123456' })
  const zs = await call('auth', 'adminLogin', { username: 'zhangshan', password: 'zs123456' })
  const zl = await call('auth', 'adminLogin', { username: 'zhaoliu', password: 'zl123456' })
  const ln = await call('auth', 'adminLogin', { username: 'lina', password: 'ln123456' })
  for (const [n, r] of [['admin', admin], ['王总', wz], ['张三', zs], ['赵六', zl], ['李娜', ln]]) {
    if (r.code !== 0) throw new Error(`${n} 登录失败：${r.message}`)
  }
  console.log('五个账号登录成功。')

  const cleanupTasks = []
  const cleanupOrders = []

  // ---------- A. 采购单价 ----------
  console.log('\n【A】采购录入单价校验')
  const t = await call(
    'purchase',
    'create',
    {
      warehouse_id: 1,
      remark: '[VERIFY] 单价校验复验',
      items: [{ material_id: spk._id, quantity: 1 }]
    },
    zl.data.token
  )
  if (t.code !== 0) throw new Error(`造采购任务失败：${t.message}`)
  cleanupTasks.push(t.data._id)
  await call('purchase', 'take', { id: t.data._id }, ln.data.token)

  const zero = await call(
    'purchase',
    'entry',
    {
      id: t.data._id,
      purchase_channel: '线下',
      items: [{ material_id: spk._id, unit_price: 0 }]
    },
    ln.data.token
  )
  record(
    'A1 单价填 0 被拦',
    zero.code !== 0,
    `entry(unit_price:0) → code=${zero.code} message=${zero.message}`
  )

  const good = await call(
    'purchase',
    'entry',
    {
      id: t.data._id,
      purchase_channel: '线下',
      external_no: `VERIFY-${Date.now()}`,
      items: [{ material_id: spk._id, unit_price: 12.5 }]
    },
    ln.data.token
  )
  record(
    'A2 对照：单价填正常值必须通过',
    good.code === 0,
    `entry(unit_price:12.5) → code=${good.code} message=${good.message}`
  )

  // ---------- B. 提权 ----------
  console.log('\n【B】角色授予边界（防提权）')
  const target = await call('user', 'list', { keyword: 'AUTOTEST_purchase', pageSize: 5 }, admin.data.token)
  const tgt = ((target.data && target.data.list) || []).find((u) => u.username === 'AUTOTEST_purchase')
  if (!tgt) throw new Error('找不到复核用账号')
  const origRoles = tgt.roles

  const byBoss = await call('user', 'updateRole', { id: tgt._id, roles: ['admin'] }, wz.data.token)
  record(
    'B1 老板授予「管理员」被拦',
    byBoss.code !== 0,
    `王总 updateRole(roles:["admin"]) → code=${byBoss.code} message=${byBoss.message}`
  )

  const byAdmin = await call('user', 'updateRole', { id: tgt._id, roles: ['admin'] }, admin.data.token)
  record(
    'B2 对照：管理员授予「管理员」必须通过',
    byAdmin.code === 0,
    `管理員 updateRole(roles:["admin"]) → code=${byAdmin.code} message=${byAdmin.message}`
  )
  // 立刻还原
  await call('user', 'updateRole', { id: tgt._id, roles: origRoles }, admin.data.token)
  const back = await call('user', 'detail', { id: tgt._id }, admin.data.token)
  record(
    'B3 还原后角色回原值',
    JSON.stringify((back.data && back.data.roles) || []) === JSON.stringify(origRoles),
    `还原后 roles=${JSON.stringify((back.data && back.data.roles) || [])}（原值 ${JSON.stringify(origRoles)}）`
  )

  // ---------- C. 总览新增字段 ----------
  console.log('\n【C】后台看板新增「待拣货 / 待收货」计数')
  const ov = await call('stats', 'overview', {}, admin.data.token)
  const hasFields =
    ov.code === 0 && ov.data && ov.data.picking_outbound !== undefined && ov.data.receiving_outbound !== undefined
  record(
    'C1 overview 返回 picking_outbound / receiving_outbound',
    hasFields,
    `picking_outbound=${ov.data && ov.data.picking_outbound} receiving_outbound=${ov.data && ov.data.receiving_outbound}`
  )

  // ---------- D. 领料员单据类型 ----------
  console.log('\n【D】领料员只能提「领用」单')
  const badType = await call(
    'outbound',
    'submit',
    {
      warehouse_id: 1,
      type: 'baofei',
      remark: '[VERIFY] 领料员提报废单',
      items: [
        { material_id: spk._id, material_name: spk.名称, material_spec: spk.规格, unit: '个', quantity: 1 }
      ]
    },
    zs.data.token
  )
  record(
    'D1 领料员提「报废」单被拦',
    badType.code !== 0,
    `张三 submit(type:baofei) → code=${badType.code} message=${badType.message}`
  )

  const okType = await call(
    'outbound',
    'submit',
    {
      warehouse_id: 1,
      type: 'baofei',
      remark: '[VERIFY] 仓管提报废单（对照）',
      items: [
        { material_id: spk._id, material_name: spk.名称, material_spec: spk.规格, unit: '个', quantity: 1 }
      ]
    },
    zl.data.token
  )
  if (okType.code === 0) cleanupOrders.push(okType.data._id)
  record(
    'D2 对照：仓管提「报废」单必须通过',
    okType.code === 0,
    `赵六 submit(type:baofei) → code=${okType.code} message=${okType.message}`
  )

  // ---------- E. 仓管待办 ----------
  console.log('\n【E】仓管采购待办不再恒为 0')
  const todo = await call('purchase', 'myTodoCount', {}, zl.data.token)
  record(
    'E1 仓管 myTodoCount 返回待收料数',
    todo.code === 0 && todo.data && todo.data.waiting_receive !== undefined,
    `赵六 myTodoCount → ${JSON.stringify(todo.data)}`
  )

  // ---------- 清理 ----------
  console.log('\n清理本次复验造的数据…')
  for (const id of cleanupTasks) {
    const r = await call('purchase', 'cancel', { id, reason: '[VERIFY] 复验完毕自动清理' }, zl.data.token)
    console.log(`  采购任务 ${id}：${r.code === 0 ? '已取消' : '取消失败 ' + r.message}`)
  }
  for (const id of cleanupOrders) {
    const r = await call('outbound', 'cancel', { id, reason: '[VERIFY] 复验完毕自动清理' }, zl.data.token)
    console.log(`  出库单 ${id}：${r.code === 0 ? '已作废' : '作废失败 ' + r.message}`)
  }

  // ---------- 汇总 ----------
  const failed = checks.filter((c) => !c.pass)
  console.log('\n' + '='.repeat(66))
  console.log(`  复验结果：${checks.length - failed.length}/${checks.length} 通过`)
  console.log('='.repeat(66))
  if (failed.length) {
    failed.forEach((f) => console.log(`  ❌ ${f.name}`))
  } else {
    console.log('  ✅ 全部修复生效，且对照场景未被误伤')
  }

  fs.writeFileSync(
    path.join(__dirname, 'v2-fix-verify-result.json'),
    JSON.stringify({ 时间: new Date().toISOString(), 通过: checks.length - failed.length, 总数: checks.length, 明细: checks }, null, 2),
    'utf8'
  )
  console.log('\n  结果已写入 tests/v2-fix-verify-result.json\n')
}

main().catch((e) => {
  console.error('\n[复验失败]', e.message)
  process.exit(1)
})
