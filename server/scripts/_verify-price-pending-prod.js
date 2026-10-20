/**
 * ============================================================
 * 生产端到端验收：成品仓「无单价入库（待补价）」— 2026-10-20
 * ------------------------------------------------------------
 * 为什么不能只靠本地测试：
 *   本地库和生产的差别在「库结构是否已迁移 / 服务是否已重启 / 代码是否真传上去」，
 *   这些本地跑一百遍也验不出来。所以必须在生产上用真实 HTTP 真打一遍。
 *
 * 判据设计的关键点：
 *   ⚠️ 在 avg_cost = 0 的物料上**证明不了「空价不稀释成本」**
 *      —— 0 乘任何数都是 0，(0×Q + 0×q)/(Q+q) = 0 与「保持原值 0」结果相同。
 *   所以先造一笔**有价**入库把成本抬到 100，再空价入库，才能看出区别：
 *     正确 100  /  错误（按 0 稀释）50
 *
 * 验证链（全部用真实物料，最后全部作废、终态回到基线）：
 *   链1  不稀释 + 作废不抬成本
 *     A 有价 10@100      → 成本 100
 *     B 空价 10          → 成本仍 100（按 0 稀释会变 50）  ← 核心判据
 *     作废 B             → 成本仍 100（按 0 冲回会变 200） ← 核心判据
 *     作废 A             → 回基线
 *   链2  零歧义补价
 *     C 空价 5           → 成本不动
 *     补价 80            → 库存未动过，成本直接定 80
 *     作废 C             → 回基线
 *   旁证
 *     配件仓空价          → 必须 400 被拒（配件仓仍要对账）
 *     待补价清单          → 能查到刚才那张单
 *
 * 数据安全：
 *   - 只增不删（生产连接池拦 DELETE），所有单据走「作废」回滚，可追溯
 *   - 任何异常都在 finally 里尝试作废已建单据，绝不留半截账
 *   - 终态断言：库存与成本必须回到开始时读到的基线
 *
 * 用法：node scripts/_verify-price-pending-prod.js
 *      KEEP=1  保留单据不作废（仅排查用，慎用）
 * ============================================================ */
require('../src/config/env')

const http = require('http')
const { signToken } = require('../src/middleware/auth')
const { query, queryOne } = require('../src/db/pool')

const BASE = 'http://127.0.0.1:3000'
const WH_GOODS = 2
const WH_PARTS = 1
const MAT_ID = Number(process.env.MAT_ID || 2)
const PRE = '【上线验收·勿用】'
const TOL = 0.001
const KEEP = process.env.KEEP === '1'

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}${detail ? `    ${detail}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}    ${detail || ''}`)
  }
}

function call(moduleName, action, data = {}, token = '', cid = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      action,
      data,
      ...(cid ? { client_request_id: cid } : {})
    })
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const req = http.request(
      `${BASE}/api/${moduleName}`,
      { method: 'POST', headers, timeout: 25000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (e) {
            reject(new Error(`响应非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 300)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(25000, () => req.destroy(new Error('请求超时')))
    req.write(payload)
    req.end()
  })
}

const mat = async () =>
  queryOne('SELECT current_stock, avg_cost, name FROM materials WHERE id = ?', [MAT_ID])

const created = [] // 需要作废的单据 id

async function cancelOrder(token, id, tag) {
  if (!id || KEEP) return { code: 0, message: 'KEEP 模式跳过' }
  const r = await call('inbound', 'cancel', { id, reason: `${PRE} ${tag} 验收后清理` }, token)
  return r
}

async function main() {
  console.log('============================================================')
  console.log('  生产端到端验收：成品仓无单价入库（待补价）')
  console.log(`  时间：${new Date().toLocaleString('zh-CN')}`)
  console.log(`  接口：${BASE}`)
  console.log('============================================================\n')

  // ---------- 身份 ----------
  const admin = await queryOne('SELECT * FROM users WHERE id = 1')
  if (!admin) throw new Error('找不到 id=1 的管理员账号')
  const token = signToken(admin)
  console.log(`身份：${admin.real_name || admin.username}（id=${admin.id}）\n`)

  const base = await mat()
  if (!base) throw new Error(`物料 id=${MAT_ID} 不存在`)
  const baseStock = Number(base.current_stock)
  const baseCost = Number(base.avg_cost)
  console.log(`基线：${base.name}  库存=${baseStock}  成本=${baseCost}\n`)

  console.log('【链1】不稀释成本 + 作废不抬成本')
  // --- A 有价入库 10@100 ---
  const ra = await call(
    'inbound',
    'submit',
    {
      items: [{ material_id: MAT_ID, material_name: base.name, quantity: 10, unit_price: 100 }],
      type: 'other',
      remark: `${PRE} A 有价入库 10@100`,
      warehouse_id: WH_GOODS
    },
    token,
    `acc-a-${Date.now()}`
  )
  check('A 有价入库 10@100 提交成功', ra.code === 0, ra.code === 0 ? ra.data.order_no : ra.message)
  const aId = ra.code === 0 ? ra.data._id : null
  if (aId) created.push(aId)

  let m = await mat()
  check(
    'A 后平均成本 = 100',
    Math.abs(Number(m.avg_cost) - 100) < TOL,
    `实际 ${m.avg_cost}`
  )
  check(
    'A 后库存 = 基线 + 10',
    Math.abs(Number(m.current_stock) - (baseStock + 10)) < TOL,
    `实际 ${m.current_stock}`
  )

  // --- B 空价入库 10 ---
  const rb = await call(
    'inbound',
    'submit',
    {
      items: [{ material_id: MAT_ID, material_name: base.name, quantity: 10, unit_price: null }],
      type: 'other',
      remark: `${PRE} B 空价入库 10`,
      warehouse_id: WH_GOODS
    },
    token,
    `acc-b-${Date.now()}`
  )
  check('B 空价入库 10 提交成功（成品仓允许留空）', rb.code === 0, rb.code === 0 ? rb.data.order_no : rb.message)
  const bId = rb.code === 0 ? rb.data._id : null
  if (bId) created.push(bId)

  m = await mat()
  check(
    'B 后平均成本仍 = 100  ← 核心判据',
    Math.abs(Number(m.avg_cost) - 100) < TOL,
    `实际 ${m.avg_cost}（若按 0 稀释会变 50）`
  )
  check(
    'B 后库存 = 基线 + 20',
    Math.abs(Number(m.current_stock) - (baseStock + 20)) < TOL,
    `实际 ${m.current_stock}`
  )

  if (bId) {
    const it = await queryOne(
      'SELECT unit_price, price_pending, total_price FROM inbound_order_items WHERE order_id = ?',
      [bId]
    )
    const od = await queryOne('SELECT pending_count, total_price FROM inbound_orders WHERE id = ?', [bId])
    check('B 明细 unit_price 存为 NULL（不是 0）', it.unit_price === null, `实际 ${JSON.stringify(it.unit_price)}`)
    check('B 明细 price_pending = 1', Number(it.price_pending) === 1, `实际 ${it.price_pending}`)
    check('B 明细 total_price = 0', Number(it.total_price) === 0, `实际 ${it.total_price}`)
    check('B 单据 pending_count = 1', Number(od.pending_count) === 1, `实际 ${od.pending_count}`)
  }

  // --- 配件仓空价必须被拒 ---
  const matParts = await queryOne(
    'SELECT id, name FROM materials WHERE warehouse_id = ? AND is_deleted = 0 LIMIT 1',
    [WH_PARTS]
  )
  if (matParts) {
    const rp = await call(
      'inbound',
      'submit',
      {
        items: [{ material_id: matParts.id, material_name: matParts.name, quantity: 1, unit_price: null }],
        type: 'other',
        remark: `${PRE} 配件仓空价（应被拒，不会落库）`,
        warehouse_id: WH_PARTS
      },
      token,
      `acc-p-${Date.now()}`
    )
    check('配件仓空价被拒（HTTP 400）', rp.code === 400, `code=${rp.code} ${rp.message}`)
    if (rp.code === 0) created.push(rp.data._id) // 万一真过了，也要清掉
  } else {
    check('配件仓空价被拒（HTTP 400）', false, '配件仓没有可用物料，无法验证')
  }

  // --- 待补价清单 ---
  const rl = await call('inbound', 'pendingPriceList', { page: 1, pageSize: 50 }, token)
  check('待补价清单接口可调', rl.code === 0, rl.message)
  if (rl.code === 0 && bId) {
    const hit = JSON.stringify(rl.data).includes(String(bId))
    check('清单里能查到 B 单', hit, hit ? '' : '未命中 B 单 id')
  }

  // --- 作废 B（仍是待补价状态）---
  if (bId) {
    const rc = await cancelOrder(token, bId, 'B')
    check('作废 B 成功', rc.code === 0, rc.message)
    m = await mat()
    check(
      '作废 B 后成本仍 = 100  ← 核心判据',
      Math.abs(Number(m.avg_cost) - 100) < TOL,
      `实际 ${m.avg_cost}（若按 0 冲回会变 200）`
    )
    check(
      '作废 B 后库存 = 基线 + 10',
      Math.abs(Number(m.current_stock) - (baseStock + 10)) < TOL,
      `实际 ${m.current_stock}`
    )
  }

  // --- 作废 A ---
  if (aId) {
    const rc = await cancelOrder(token, aId, 'A')
    check('作废 A 成功', rc.code === 0, rc.message)
    m = await mat()
    check(
      '作废 A 后库存回到基线',
      Math.abs(Number(m.current_stock) - baseStock) < TOL,
      `实际 ${m.current_stock}  基线 ${baseStock}`
    )
    check(
      '作废 A 后成本回到基线',
      Math.abs(Number(m.avg_cost) - baseCost) < TOL,
      `实际 ${m.avg_cost}  基线 ${baseCost}`
    )
  }

  // ---------- 链2：零歧义补价 ----------
  console.log('\n【链2】零歧义补价（这批之后没有别的进出）')
  const rc2 = await call(
    'inbound',
    'submit',
    {
      items: [{ material_id: MAT_ID, material_name: base.name, quantity: 5, unit_price: null }],
      type: 'other',
      remark: `${PRE} C 空价入库 5（待补价→补价）`,
      warehouse_id: WH_GOODS
    },
    token,
    `acc-c-${Date.now()}`
  )
  check('C 空价入库 5 提交成功', rc2.code === 0, rc2.code === 0 ? rc2.data.order_no : rc2.message)
  const cId = rc2.code === 0 ? rc2.data._id : null
  if (cId) created.push(cId)

  if (cId) {
    const rp = await call(
      'inbound',
      'updatePrice',
      { id: cId, items: [{ material_id: MAT_ID, unit_price: 80 }] },
      token
    )
    check('C 补价 80 成功', rp.code === 0, rp.code === 0 ? JSON.stringify(rp.data).slice(0, 120) : rp.message)

    const od = await queryOne('SELECT pending_count, total_price FROM inbound_orders WHERE id = ?', [cId])
    const it = await queryOne(
      'SELECT unit_price, price_pending FROM inbound_order_items WHERE order_id = ?',
      [cId]
    )
    check('C 补价后 pending_count = 0', Number(od.pending_count) === 0, `实际 ${od.pending_count}`)
    check('C 补价后明细 price_pending = 0', Number(it.price_pending) === 0, `实际 ${it.price_pending}`)
    check('C 补价后 unit_price = 80', Math.abs(Number(it.unit_price) - 80) < TOL, `实际 ${it.unit_price}`)
    check('C 补价后单据总额 = 400', Math.abs(Number(od.total_price) - 400) < TOL, `实际 ${od.total_price}`)

    m = await mat()
    check(
      'C 补价后成本 = 80（零歧义直接定成本）',
      Math.abs(Number(m.avg_cost) - 80) < TOL,
      `实际 ${m.avg_cost}`
    )

    const rcc = await cancelOrder(token, cId, 'C')
    check('作废 C 成功', rcc.code === 0, rcc.message)
    m = await mat()
    check(
      '作废 C 后库存回到基线',
      Math.abs(Number(m.current_stock) - baseStock) < TOL,
      `实际 ${m.current_stock}`
    )
    check(
      '作废 C 后成本回到基线',
      Math.abs(Number(m.avg_cost) - baseCost) < TOL,
      `实际 ${m.avg_cost}  基线 ${baseCost}`
    )
  }

  // ---------- 汇总 ----------
  console.log('\n============================================================')
  console.log(`  共 ${passed + failed} 项检查，通过 ${passed}，失败 ${failed}`)
  if (failed) {
    console.log('  失败项：')
    failures.forEach((f) => console.log(`    · ${f}`))
    console.log('  ⚠️ 验收未通过，请看上面的明细与数据库实际值')
  } else {
    console.log('  ✅ 生产端到端全部通过')
  }
  console.log('============================================================')
  process.exit(failed ? 1 : 0)
}

// 异常也要把已建单据收掉，绝不留半截账
main().catch(async (e) => {
  console.error('\n❌ 验收过程异常：', e.message)
  try {
    const admin = await queryOne('SELECT * FROM users WHERE id = 1')
    const token = admin ? signToken(admin) : ''
    for (const id of created) {
      const r = await cancelOrder(token, id, '异常兜底')
      console.error(`   兜底作废 id=${id} → ${r.code === 0 ? '成功' : r.message}`)
    }
  } catch (e2) {
    console.error('   ⚠️ 兜底作废也失败，请人工检查 created =', created)
  }
  process.exit(1)
})
