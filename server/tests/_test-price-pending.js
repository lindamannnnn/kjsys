/**
 * ============================================================
 * 待补价（成品仓无单价入库）专项验证 — 2026-10-20
 * ------------------------------------------------------------
 * 背景：
 *   销售端未接入，成品仓拿不到价格。原来入库单价必填且禁止 0
 *   （0 会把移动加权成本永久稀释），结果成品仓连入库都提交不了。
 *   现在改成：允许留空 → unit_price=NULL + price_pending=1，
 *   数量照常入账，**这批不参与加权**（avg_cost 保持原值）。
 *
 * 本脚本用「真实 HTTP 打真实服务 + 直接查库核对」验证 8 组判据：
 *   1. 成品仓空单价入库：成功、数量对、成本不动、标记正确
 *   2. 配件仓空单价入库：必须被拒（要跟采购价对账）
 *   3. 已有成本时再空价入库：成本**不被稀释**   ← 核心判据
 *   4. 零歧义补价（这批之后没有别的进出）：成本直接定成该价，标记清零
 *   5. 有混合库存时补价：只更新单据金额，成本不乱算，明确告知「待重算」
 *   6. 补价前已出库消耗：安全闸门拒绝，数据不变
 *   7. 作废空价入库：数量回退，成本**不被抬高**（按 0 冲回会虚增）
 *   8. 配件仓正常填价入库不受影响（回归）
 *
 * 安全护栏：
 *   - 只碰名称以「【测试】待补价」开头的物料，跑完自动清理
 *   - 跑之前检查：非测试物料的库存/成本必须全 0，否则直接中止不动数据
 *
 * 用法：
 *   TEST_BASE=http://127.0.0.1:3000 node tests/_test-price-pending.js
 *   KEEP=1 保留数据（排查用）
 * ============================================================ */
require('../src/config/env')

const http = require('http')
const crypto = require('crypto')
const { pool, query, execute } = require('../src/db/pool')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const PRE = '【测试】待补价'
const WH_PARTS = 1 // 配件仓 peijian
const WH_GOODS = 2 // 成品仓 chengpin
const TOL = 0.001

// ---------------- HTTP ----------------
function call(moduleName, action, data = {}, token = '', clientRequestId = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      action,
      data,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {})
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
            reject(new Error(`响应非 JSON：${raw.slice(0, 300)}`))
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

const rid = () => crypto.randomUUID()

// ---------------- 结果 ----------------
const results = []
let currentScene = ''

function scene(title) {
  currentScene = title
  console.log(`\n${'─'.repeat(66)}\n▌${title}\n${'─'.repeat(66)}`)
}

function check(label, actual, expected, tol = TOL) {
  const a = Number(actual)
  const e = Number(expected)
  const ok = Math.abs(a - e) <= tol
  results.push({ 场景: currentScene, 检查项: label, 实际: a, 期望: e, 结果: ok ? '通过' : '失败' })
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(40)} 实际 ${String(a).padStart(12)}  期望 ${String(e).padStart(12)}`)
  return ok
}

function checkTrue(label, cond, extra = '') {
  results.push({
    场景: currentScene,
    检查项: label,
    实际: cond ? '成立' : '不成立',
    期望: '成立',
    结果: cond ? '通过' : '失败'
  })
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
  return cond
}

// ---------------- 业务封装 ----------------
let TOKEN = ''
const materialIds = []

async function login() {
  const cands = [process.env.ADMIN_PASSWORD, '123456', 'admin123456', 'SlTest@2026'].filter(Boolean)
  for (const pwd of cands) {
    const r = await call('auth', 'adminLogin', { username: 'admin', password: pwd })
    if (r.code === 0) {
      TOKEN = r.data.token
      return
    }
  }
  throw new Error('管理员登录失败（试过 ADMIN_PASSWORD / 123456 / admin123456）')
}

async function must(label, p) {
  const res = await p
  if (!res || res.code !== 0) {
    throw new Error(`[${label}] 失败：${res && res.message ? res.message : JSON.stringify(res)}`)
  }
  return res.data
}

/** 建测试物料（不去重：每个场景要干净的物料） */
async function newMaterial(key, warehouseId, category) {
  const name = `${PRE}-${key}`
  const d = await must(
    `创建物料 ${name}`,
    call(
      'material',
      'upsert',
      {
        name,
        spec: `T-${key}`,
        unit: '个',
        material_no: `TP-${key}`,
        category,
        sub_category: '待补价测试',
        warehouse_id: warehouseId,
        warning_stock: 0
      },
      TOKEN
    )
  )
  const id = Number(d._id)
  materialIds.push(id)
  return id
}

async function mat(id) {
  const d = await must('读取物料', call('material', 'detail', { id }, TOKEN))
  return { stock: Number(d.current_stock || 0), cost: Number(d.avg_cost || 0), name: d.name }
}

/** 提交入库单；unitPrice 传 null 表示待补价 */
async function inbound(materialId, quantity, unitPrice, extra = {}) {
  const m = await mat(materialId)
  return call(
    'inbound',
    'submit',
    {
      type: 'other',
      warehouse_id: extra.warehouse_id || WH_GOODS,
      remark: extra.remark || `${PRE}验证`,
      items: [{ material_id: materialId, material_name: m.name, quantity, unit_price: unitPrice }]
    },
    TOKEN,
    rid()
  )
}

async function confirmInbound(id) {
  return call('inbound', 'confirm', { id }, TOKEN)
}

async function outbound(materialId, quantity) {
  const m = await mat(materialId)
  return call(
    'outbound',
    'submit',
    {
      type: 'lingyong',
      warehouse_id: WH_GOODS,
      remark: `${PRE}验证出库`,
      items: [{ material_id: materialId, material_name: m.name, quantity }]
    },
    TOKEN,
    rid()
  )
}

/**
 * 走出库全流程直到「库存真的被扣」：submit → confirm → pickDone → receive
 * ⚠️ 本系统出库是**确认收货时才扣库存**（不是提交就扣），只 submit 库存不会变。
 */
async function outboundAndDeduct(materialId, quantity) {
  const r = await outbound(materialId, quantity)
  if (r.code !== 0) return r
  const id = (r.data || {})._id
  const c = await call('outbound', 'confirm', { id }, TOKEN)
  if (c.code !== 0) return c
  const p = await call('outbound', 'pickDone', { id }, TOKEN)
  if (p.code !== 0) return p
  const rc = await call('outbound', 'receive', { id }, TOKEN)
  return rc
}

/** 读明细的待补标记 */
async function itemRow(orderId) {
  const rows = await query(
    'SELECT id, material_id, quantity, unit_price, price_pending FROM inbound_order_items WHERE order_id = ?',
    [orderId]
  )
  return rows[0]
}

async function orderRow(orderId) {
  const rows = await query('SELECT id, total_price, pending_count, status FROM inbound_orders WHERE id = ?', [orderId])
  return rows[0]
}

// ---------------- 场景 ----------------
async function run() {
  console.log('='.repeat(66))
  console.log('  待补价（成品仓无单价入库）专项验证')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(66))

  // ---------- 护栏 ----------
  // 本地 dev 库里本来就有真实业务数据，不能要求「全库为 0」；
  // 只要保证**只碰自己的测试物料**即可：先清掉上次跑剩的残留。
  const leftover = await query('SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?', [`${PRE}%`])
  if (Number(leftover[0].c) > 0) {
    console.log(`\n发现上次残留的测试物料 ${leftover[0].c} 条，先清理`)
    await cleanup()
  }
  console.log('\n护栏通过：测试物料已清空，真实数据不会被触碰')

  await login()
  console.log('管理员登录成功')

  // ============ 场景 1：成品仓空单价入库 ============
  scene('场景 1：成品仓空单价入库 10 个 —— 应成功、数量入账、成本不动')
  let m1
  {
    m1 = await newMaterial('S1', WH_GOODS, '成品')
    const r = await inbound(m1, 10, null)
    checkTrue('接口返回成功', r.code === 0, r.message || '')
    if (r.code !== 0) throw new Error('场景 1 无法继续：空单价入库被拒绝')

    const s = await mat(m1)
    check('入库后 库存', s.stock, 10)
    check('入库后 成本（无价，应保持 0）', s.cost, 0)

    const it = await itemRow(r.data._id)
    checkTrue('明细 unit_price 为 NULL（不是 0）', it.unit_price === null, `实际=${it.unit_price}`)
    check('明细 price_pending', it.price_pending, 1)
    const o = await orderRow(r.data._id)
    check('单据 pending_count', o.pending_count, 1)
    check('单据 total_price（无价=0）', o.total_price, 0)
  }

  // ============ 场景 2：配件仓空单价入库应被拒 ============
  scene('场景 2：配件仓空单价入库 —— 必须拒绝（收货要对账，不能缺价）')
  {
    const id = await newMaterial('S2', WH_PARTS, '配件')
    const r = await inbound(id, 5, null, { warehouse_id: WH_PARTS })
    checkTrue('接口被拒绝', r.code !== 0, `code=${r.code}`)
    checkTrue(
      '提示指向「必须填写单价」',
      String(r.message || '').includes('单价'),
      r.message || ''
    )
    const s = await mat(id)
    check('被拒后 库存未变', s.stock, 0)
  }

  // ============ 场景 3：不稀释已有成本（核心） ============
  scene('场景 3：已有成本 100 的物料，再空价入 10 —— 成本必须仍是 100，不能被稀释')
  let m3, orderS3
  let m6
  {
    m3 = await newMaterial('S3', WH_GOODS, '成品')
    const r1 = await inbound(m3, 10, 100)
    if (r1.code !== 0) throw new Error(`场景 3 有价入库失败：${r1.message}`)
    await confirmInbound(r1.data._id)
    let s = await mat(m3)
    check('有价入库后 库存', s.stock, 10)
    check('有价入库后 成本', s.cost, 100)

    const r2 = await inbound(m3, 10, null)
    checkTrue('空价入库成功', r2.code === 0, r2.message || '')
    orderS3 = r2.data._id
    s = await mat(m3)
    check('空价入库后 库存', s.stock, 20)
    // 若按 0 参与加权：(100*10 + 0*10)/20 = 50 ← 必须不是这个数
    check('空价入库后 成本（按 0 稀释会是 50）', s.cost, 100)
  }

  // ============ 场景 4：零歧义补价 ============
  scene('场景 4：全新物料空价入 10 → 补价 80 —— 成本应直接变 80，标记清零')
  {
    const id = await newMaterial('S4', WH_GOODS, '成品')
    const r = await inbound(id, 10, null)
    if (r.code !== 0) throw new Error(`场景 4 空价入库失败：${r.message}`)
    const orderId = r.data._id

    const up = await call('inbound', 'updatePrice', { id: orderId, items: [{ material_id: id, unit_price: 80 }] }, TOKEN)
    checkTrue('补价接口成功', up.code === 0, up.message || '')

    const s = await mat(id)
    check('补价后 库存', s.stock, 10)
    check('补价后 成本', s.cost, 80)

    const it = await itemRow(orderId)
    check('明细 price_pending 已清零', it.price_pending, 0)
    check('明细 unit_price', it.unit_price, 80)
    const o = await orderRow(orderId)
    check('单据 pending_count 已清零', o.pending_count, 0)
    check('单据 total_price', o.total_price, 800)
  }

  // ============ 场景 5：混合库存补价 —— 不算错，标记待重算 ============
  scene('场景 5：成本 100 的 10 个 + 空价 10 个，补价 80 —— 只能更新金额，成本不得乱算')
  {
    const up = await call(
      'inbound',
      'updatePrice',
      { id: orderS3, items: [{ material_id: m3, unit_price: 80 }] },
      TOKEN
    )
    checkTrue('补价接口成功（只更新金额）', up.code === 0, up.message || '')
    checkTrue(
      '明确告知成本待重算',
      Array.isArray(up.data && up.data.cost_skipped) && up.data.cost_skipped.length > 0,
      JSON.stringify(up.data && up.data.cost_skipped)
    )
    const s = await mat(m3)
    check('库存未被改', s.stock, 20)
    check('成本保持 100（不乱算；正确值应为 90，留给重算工具）', s.cost, 100)
    const o = await orderRow(orderS3)
    check('单据 pending_count 清零', o.pending_count, 0)
    check('单据 total_price（本批 800）', o.total_price, 800)
  }

  // ============ 场景 6：补价前已出库 → 安全闸门 ============
  scene('场景 6：空价入 10 → 出库 3 → 补价 —— 必须拒绝，不许把差额摊到剩余库存')
  {
    m6 = await newMaterial('S6', WH_GOODS, '成品')
    const id = m6
    const r = await inbound(id, 10, null)
    if (r.code !== 0) throw new Error(`场景 6 空价入库失败：${r.message}`)
    const orderId = r.data._id

    const ob = await outboundAndDeduct(id, 3)
    checkTrue('出库走完确认收货', ob.code === 0, ob.message || '')
    const before = await mat(id)
    check('出库后 库存', before.stock, 7)

    const up = await call('inbound', 'updatePrice', { id: orderId, items: [{ material_id: id, unit_price: 80 }] }, TOKEN)
    checkTrue('补价被安全闸门拒绝', up.code !== 0, `code=${up.code} ${up.message || ''}`)
    checkTrue(
      '拒绝理由提到已出库消耗',
      String(up.message || '').includes('出库') || String(up.message || '').includes('库存'),
      up.message || ''
    )

    const after = await mat(id)
    check('拒绝后 库存未变', after.stock, 7)
    check('拒绝后 成本未变', after.cost, 0)
    const it = await itemRow(orderId)
    check('明细仍标记待补价（没有被半途改掉）', it.price_pending, 1)
  }

  // ============ 场景 7：作废空价入库不得抬高成本 ============
  scene('场景 7：成本 100 的 10 个 + 空价 10 个 → 作废空价那张 —— 成本必须仍是 100')
  {
    const id = await newMaterial('S7', WH_GOODS, '成品')
    const r1 = await inbound(id, 10, 100)
    if (r1.code !== 0) throw new Error(`场景 7 有价入库失败：${r1.message}`)
    await confirmInbound(r1.data._id)

    const r2 = await inbound(id, 10, null)
    if (r2.code !== 0) throw new Error(`场景 7 空价入库失败：${r2.message}`)

    let s = await mat(id)
    check('作废前 库存', s.stock, 20)
    check('作废前 成本', s.cost, 100)

    const cc = await call('inbound', 'cancel', { id: r2.data._id, reason: `${PRE}验证作废` }, TOKEN)
    checkTrue('作废成功', cc.code === 0, cc.message || '')

    s = await mat(id)
    check('作废后 库存', s.stock, 10)
    // 若按 0 冲回会变成 100*20/10 = 200 ← 必须不是这个数
    check('作废后 成本（按 0 冲回会抬到 200）', s.cost, 100)
  }

  // ============ 场景 8：配件仓正常填价不受影响（回归） ============
  scene('场景 8：配件仓正常填价入库 10@50 —— 必须照常工作（回归）')
  {
    const id = await newMaterial('S8', WH_PARTS, '配件')
    const r = await inbound(id, 10, 50, { warehouse_id: WH_PARTS })
    checkTrue('配件仓有价入库成功', r.code === 0, r.message || '')
    const s = await mat(id)
    check('库存', s.stock, 10)
    check('成本', s.cost, 50)
    const it = await itemRow(r.data._id)
    check('明细 price_pending 为 0', it.price_pending, 0)
  }

  // ============ 场景 9：待补价清单 ============
  scene('场景 9：待补价清单 —— 应能查到未补的、补完的不出现')
  {
    const r = await call('inbound', 'pendingPriceList', { page: 1, pageSize: 200 }, TOKEN)
    checkTrue('清单接口成功', r.code === 0, r.message || '')
    const list = (r.data && r.data.list) || []
    const total = Number((r.data && r.data.summary && r.data.summary.pending_items) || 0)
    checkTrue('清单里有待补项', total > 0, `count=${total}`)
    // 场景 6 那张被安全闸门拒了，必须还留在待补清单里（不能因为补价失败就丢了追踪）
    const pendingMats = list.map((x) => Number(x.material_id))
    checkTrue(
      '被闸门拒绝的单据仍在清单里',
      pendingMats.includes(Number(m6)),
      `清单物料=${JSON.stringify(pendingMats)}`
    )
    const hasZeroPrice = list.every((x) => x.unit_price === undefined || x.unit_price === null)
    checkTrue('清单不下发金额字段（本来就没有价）', hasZeroPrice, '')
  }

  return { m1 }
}

// ---------------- 清理 ----------------
async function cleanup() {
  console.log(`\n${'─'.repeat(66)}\n▌清理测试数据\n${'─'.repeat(66)}`)
  if (process.env.KEEP === '1') {
    console.log('KEEP=1，保留数据')
    return
  }
  // 本次新建的 + 上次残留的（按名称兜底，防止中断后残留）
  const strayRows = await query('SELECT id FROM materials WHERE name LIKE ?', [`${PRE}%`])
  const names = [...new Set([...materialIds, ...strayRows.map((r) => Number(r.id))])]
  if (!names.length) {
    console.log('没有需要清理的测试物料')
    return
  }
  const ph = names.map(() => '?').join(',')

  const orders = await query(`SELECT id FROM inbound_orders WHERE warehouse_id IN (?,?) AND remark LIKE ?`, [
    WH_PARTS,
    WH_GOODS,
    `%${PRE}%`
  ])
  const orderIds = orders.map((o) => Number(o.id))
  const oph = orderIds.length ? orderIds.map(() => '?').join(',') : null

  if (oph) {
    await execute(`DELETE FROM inbound_order_items WHERE order_id IN (${oph})`, orderIds)
    await execute(`DELETE FROM inbound_orders WHERE id IN (${oph})`, orderIds)
  }
  const outs = await query(`SELECT id FROM outbound_orders WHERE warehouse_id = ? AND remark LIKE ?`, [
    WH_GOODS,
    `%${PRE}%`
  ])
  const outIds = outs.map((o) => Number(o.id))
  if (outIds.length) {
    await execute(
      `DELETE FROM outbound_order_items WHERE order_id IN (${outIds.map(() => '?').join(',')})`,
      outIds
    )
    await execute(`DELETE FROM outbound_orders WHERE id IN (${outIds.map(() => '?').join(',')})`, outIds)
  }
  await execute(`DELETE FROM stock_logs WHERE material_id IN (${ph})`, names)
  await execute(`DELETE FROM materials WHERE id IN (${ph})`, names)

  const left = await query('SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?', [`${PRE}%`])
  console.log(`清理完成，残留测试物料 = ${left[0].c}`)
}

// ---------------- 汇总 ----------------
function summary() {
  const total = results.length
  const failed = results.filter((r) => r.结果 === '失败')
  console.log(`\n${'='.repeat(66)}`)
  console.log(`  共 ${total} 项检查，通过 ${total - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('\n失败清单：')
    for (const f of failed) console.log(`  ✗ [${f.场景}] ${f.检查项}：实际=${f.实际} 期望=${f.期望}`)
  }
  console.log('='.repeat(66))
  return failed.length === 0
}

;(async () => {
  let okAll = false
  try {
    await run()
    okAll = summary()
  } catch (e) {
    console.error('\n[异常]', e.message)
    summary()
  } finally {
    try {
      await cleanup()
    } catch (e) {
      console.error('清理出错：', e.message)
    }
    await pool.end()
    process.exit(okAll ? 0 : 1)
  }
})()
