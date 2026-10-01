/**
 * ============================================================
 * P0 专项验证：入库作废是否正确冲回「移动加权平均成本」
 * ------------------------------------------------------------
 * 缺陷原文（4 角色使用者测试，3 个岗位独立复现）：
 *   入库后作废，库存数量回来了，但 avg_cost 一分不回退。
 *   实测 刹车片 88 → 入库后 108.8993 → 作废后仍是 108.8993（应回到 88）。
 *   根因：server/src/services/stock.js 的 restoreForInboundCancel
 *         只调 applyChange 扣数量、成本不变，与 addForInbound 完全不对称。
 *
 * 本脚本用「真实 HTTP 请求打真实服务」验证修复，覆盖 10 个场景：
 *   1. 单批入库 → 作废，成本精确回退
 *   2. 基数 + 单批 → 作废，回到基数成本        ← P0 核心判据
 *   3. 三批入库，逐张倒着作废，成本逐级回退
 *   4. 改价后再作废，不重复计算（与 updatePrice 的修正口径对齐）
 *   5. 入库后被领用一部分，再作废（成本非负）
 *   6. 已确认单据作废（管理员路径）
 *   7. 已被领用超量时作废必须被拒绝，且数据不变
 *   8. 作废流水留痕（含成本变化说明）
 *   9. 出库撤销不误改成本（对称性：出库不改成本）
 *  10. 10 轮「入库 → 作废」压力测试，成本必须零漂移  ← 最强判据
 *
 * 安全护栏（任一不满足直接中止，不碰数据）：
 *   - 只建、只改、只删名称以「【测试】P0」开头的物料
 *   - 真实物料（其余 1909 条）库存/成本必须全 0，且不得有流水
 *
 * 用法：
 *   TEST_BASE=http://127.0.0.1:3000 node tests/p0-cost-rollback-test.js
 *   KEEP=1 保留测试数据（排查用），默认跑完自动清理
 * ============================================================ */
require('../src/config/env')

const http = require('http')
const crypto = require('crypto')
const { pool, query, execute, withTransaction } = require('../src/db/pool')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const PRE = '【测试】P0'
const TOL = 0.001 // 成本四位小数，留一点浮点余量

// ---------------- HTTP 调用（与前端 callCloud 同构） ----------------
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

    const req = http.request(`${BASE}/api/${moduleName}`,
      { method: 'POST', headers, timeout: 25000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`响应非 JSON：${raw.slice(0, 300)}`)) }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(payload)
    req.end()
  })
}

const rid = () => crypto.randomUUID()

// ---------------- 结果记录 ----------------
const results = []
let currentScene = ''

function scene(title) {
  currentScene = title
  console.log(`\n${'─'.repeat(64)}\n▌${title}\n${'─'.repeat(64)}`)
}

function check(label, actual, expected, tol = TOL) {
  const a = Number(actual)
  const e = Number(expected)
  const ok = Math.abs(a - e) <= tol
  results.push({ 场景: currentScene, 检查项: label, 实际: a, 期望: e, 结果: ok ? '通过' : '失败' })
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(38)} 实际 ${String(a).padStart(12)}  期望 ${String(e).padStart(12)}`)
  return ok
}

function checkTrue(label, cond, extra = '') {
  results.push({ 场景: currentScene, 检查项: label, 实际: cond ? '成立' : '不成立', 期望: '成立', 结果: cond ? '通过' : '失败' })
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
  return cond
}

// ---------------- 业务动作 ----------------
let TOKEN = ''
const createdMaterialIds = []
const createdOrderIds = { inbound: [], outbound: [] }

async function login() {
  const pwd = process.env.ADMIN_PASSWORD || '123456'
  let r = await call('auth', 'adminLogin', { username: 'admin', password: pwd })
  if (r.code !== 0) r = await call('auth', 'adminLogin', { username: 'admin', password: 'admin123456' })
  if (r.code !== 0) r = await call('auth', 'adminLogin', { username: 'admin', password: '123456' })
  if (r.code !== 0) throw new Error(`管理员登录失败：${r.message}`)
  TOKEN = r.data.token
  if (r.data.must_change_password) {
    console.warn('  ⚠ admin 被要求改密码，可能影响后续调用')
  }
}

async function must(label, p) {
  const res = await p
  if (!res || res.code !== 0) {
    throw new Error(`[${label}] 失败：${res && res.message ? res.message : JSON.stringify(res)}`)
  }
  return res.data
}

async function newMaterial(key, baseQty = 0, basePrice = 0) {
  const name = `${PRE}${key}`
  const found = await call('material', 'list', { keyword: name, pageSize: 20 }, TOKEN)
  const row = (found.data && found.data.list || []).find((x) => x.name === name)
  if (row) {
    createdMaterialIds.push(Number(row._id))
    return Number(row._id)
  }
  const d = await must(`创建物料 ${name}`, call('material', 'upsert', {
    name, spec: `P0-${key}`, unit: '个', material_no: `P0-${key}`,
    category: '配件', sub_category: 'P0 成本回退测试', warehouse_id: 1, warning_stock: 0
  }, TOKEN))
  const id = Number(d._id)
  createdMaterialIds.push(id)
  if (baseQty > 0) {
    const o = await inbound(id, baseQty, basePrice, `建立基数 ${baseQty}@${basePrice}`)
    await confirmInbound(o._id)
  }
  return id
}

async function mat(id) {
  const d = await must('读取物料', call('material', 'detail', { id }, TOKEN))
  return { stock: Number(d.current_stock || 0), cost: Number(d.avg_cost || 0), name: d.name }
}

async function inbound(materialId, quantity, unitPrice, remark = '') {
  const m = await mat(materialId)
  const r = await must(`入库 ${m.name} ×${quantity}@${unitPrice}`, call('inbound', 'submit', {
    type: 'purchase', warehouse_id: 1, supplier: `${PRE}供应商`, remark,
    items: [{
      material_id: materialId, material_name: m.name,
      quantity, unit_price: unitPrice
    }]
  }, TOKEN, rid()))
  createdOrderIds.inbound.push(Number(r._id))
  return r
}

async function confirmInbound(id) {
  return must('确认入库单', call('inbound', 'confirm', { id }, TOKEN))
}

/** 作废入库单；返回原始响应（用于「应被拒绝」的用例） */
async function cancelInbound(id, reason = 'P0 验证：作废') {
  return call('inbound', 'cancel', { id, reason }, TOKEN)
}

async function outbound(materialId, quantity, remark = '') {
  const m = await mat(materialId)
  const r = await must(`出库 ${m.name} ×${quantity}`, call('outbound', 'submit', {
    type: 'lingyong', warehouse_id: 1, remark,
    items: [{ material_id: materialId, material_name: m.name, quantity }]
  }, TOKEN, rid()))
  createdOrderIds.outbound.push(Number(r._id))
  return r
}

async function cancelOutbound(id, reason = 'P0 验证：出库撤销') {
  return must('撤销出库单', call('outbound', 'cancel', { id, reason }, TOKEN))
}

/** 加权成本理论值：(原库存金额 + 本次入库金额) / 总数量 */
function expectAvgCost(stockBefore, costBefore, addQty, addPrice) {
  const total = stockBefore + addQty
  if (total <= 0) return 0
  return Number((((costBefore * stockBefore) + (addPrice * addQty)) / total).toFixed(4))
}

// ---------------- 场景 ----------------
async function main() {
  console.log('='.repeat(64))
  console.log('  P0 专项验证：入库作废回退加权成本')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(64))

  // ---------- 护栏 ----------
  const real = await query(
    `SELECT COUNT(*) AS c FROM materials
      WHERE is_deleted = 0 AND name NOT LIKE ? AND (current_stock <> 0 OR avg_cost <> 0)`,
    [`${PRE}%`]
  )
  if (real[0].c > 0) {
    console.error(`\n[中止] 有 ${real[0].c} 条真实物料库存/成本不为 0，疑似已被污染，脚本不做任何写操作。`)
    process.exit(1)
  }
  const realLogs = await query(
    `SELECT COUNT(*) AS c FROM stock_logs l JOIN materials m ON m.id = l.material_id WHERE m.name NOT LIKE ?`,
    [`${PRE}%`]
  )
  if (realLogs[0].c > 0) {
    console.error(`\n[中止] 真实物料存在 ${realLogs[0].c} 条库存流水，脚本不做任何写操作。`)
    process.exit(1)
  }
  console.log('\n护栏通过：真实物料库存/成本全 0，无流水')

  await login()
  console.log('管理员登录成功\n')

  // ================= 场景 1：空物料，单批入库 → 作废 =================
  scene('场景 1：空物料入库 10@100 → 作废，数量与成本都应归零')
  {
    const id = await newMaterial('S1', 0, 0)
    let s = await mat(id)
    check('入库前 库存', s.stock, 0)
    check('入库前 成本', s.cost, 0)

    const o = await inbound(id, 10, 100, 'P0-1')
    s = await mat(id)
    check('入库后 库存', s.stock, 10)
    check('入库后 成本', s.cost, expectAvgCost(0, 0, 10, 100))

    await cancelInbound(o._id)
    s = await mat(id)
    check('作废后 库存', s.stock, 0)
    check('作废后 成本（旧实现会是 100）', s.cost, 0)
  }

  // ================= 场景 2：P0 核心判据 =================
  scene('场景 2【P0 核心】：基数 100@10，再入库 10@200 → 作废，成本必须回到 10')
  {
    const id = await newMaterial('S2', 100, 10)
    let s = await mat(id)
    check('基数 库存', s.stock, 100)
    check('基数 成本', s.cost, 10)

    const o = await inbound(id, 10, 200, 'P0-2')
    s = await mat(id)
    check('入库后 库存', s.stock, 110)
    check('入库后 成本', s.cost, expectAvgCost(100, 10, 10, 200)) // 27.2727

    await cancelInbound(o._id)
    s = await mat(id)
    check('作废后 库存', s.stock, 100)
    check('作废后 成本（旧实现残留 27.2727）', s.cost, 10)
  }

  // ================= 场景 3：三批倒序作废 =================
  scene('场景 3：三批入库（100@10 / 50@30 / 50@60），倒序作废应逐级回退')
  {
    const id = await newMaterial('S3', 0, 0)
    const oA = await inbound(id, 100, 10, 'P0-3 A')
    let s = await mat(id)
    const cA = s.cost
    check('A 后 成本', cA, expectAvgCost(0, 0, 100, 10))

    const oB = await inbound(id, 50, 30, 'P0-3 B')
    s = await mat(id)
    const cB = s.cost
    check('B 后 库存', s.stock, 150)
    check('B 后 成本', cB, expectAvgCost(100, cA, 50, 30)) // 16.6667

    const oC = await inbound(id, 50, 60, 'P0-3 C')
    s = await mat(id)
    check('C 后 库存', s.stock, 200)
    check('C 后 成本', s.cost, expectAvgCost(150, cB, 50, 60)) // 27.5

    await cancelInbound(oC._id)
    s = await mat(id)
    check('作废 C 后 库存', s.stock, 150)
    check('作废 C 后 成本（应回到 B 后的值）', s.cost, cB)

    await cancelInbound(oB._id)
    s = await mat(id)
    check('作废 B 后 库存', s.stock, 100)
    check('作废 B 后 成本', s.cost, cA)

    await cancelInbound(oA._id)
    s = await mat(id)
    check('作废 A 后 库存', s.stock, 0)
    check('作废 A 后 成本', s.cost, 0)
  }

  // ================= 场景 4：改价后作废不双算 =================
  scene('场景 4：基数 100@10 → 入库 10@200 → 改价为 100 → 作废，成本回到 10')
  {
    const id = await newMaterial('S4', 100, 10)
    const o = await inbound(id, 10, 200, 'P0-4')
    let s = await mat(id)
    check('入库后 成本', s.cost, expectAvgCost(100, 10, 10, 200)) // 27.2727

    // 改价 200 → 100（updatePrice 会按金额差额修正 avg_cost，数量不变）
    await must('改价', call('inbound', 'updatePrice', {
      id: o._id, items: [{ material_id: id, unit_price: 100 }]
    }, TOKEN))
    s = await mat(id)
    check('改价后 库存（应不变）', s.stock, 110)
    check('改价后 成本（等价于按 100 入库）', s.cost, expectAvgCost(100, 10, 10, 100)) // 18.1818

    await cancelInbound(o._id)
    s = await mat(id)
    check('作废后 库存', s.stock, 100)
    check('作废后 成本', s.cost, 10)
  }

  // ================= 场景 5：入库后被领用一部分再作废 =================
  scene('场景 5：基数 100@10 → 入库 20@50 → 出库 30 → 作废入库单（成本非负、数量正确）')
  {
    const id = await newMaterial('S5', 100, 10)
    const o = await inbound(id, 20, 50, 'P0-5')
    let s = await mat(id)
    const costAfterIn = s.cost
    check('入库后 库存', s.stock, 120)
    check('入库后 成本', costAfterIn, expectAvgCost(100, 10, 20, 50)) // 16.6667

    await outbound(id, 30, 'P0-5 领用')
    s = await mat(id)
    check('出库后 库存', s.stock, 90)
    check('出库后 成本（出库不改成本）', s.cost, costAfterIn)

    await cancelInbound(o._id)
    s = await mat(id)
    const expectCost = Number((((costAfterIn * 90) - (50 * 20)) / 70).toFixed(4)) // 7.1429
    check('作废后 库存', s.stock, 70)
    check('作废后 成本（按批次冲回）', s.cost, expectCost)
    checkTrue('作废后 成本非负', s.cost >= 0, `成本=${s.cost}`)
  }

  // ================= 场景 6：已确认单据作废 =================
  scene('场景 6：入库 → 仓管确认 → 管理员作废，成本仍应回退')
  {
    const id = await newMaterial('S6', 100, 10)
    const o = await inbound(id, 10, 100, 'P0-6')
    await confirmInbound(o._id)
    let s = await mat(id)
    check('确认后 库存', s.stock, 110)
    check('确认后 成本', s.cost, expectAvgCost(100, 10, 10, 100)) // 18.1818

    await cancelInbound(o._id, 'P0-6 已确认单作废')
    s = await mat(id)
    check('作废后 库存', s.stock, 100)
    check('作废后 成本', s.cost, 10)
  }

  // ================= 场景 7：超量作废应被拒绝 =================
  scene('场景 7：入库 10 后被领用 105（剩 5），作废必须被拒绝且数据不变')
  {
    const id = await newMaterial('S7', 100, 10)
    const o = await inbound(id, 10, 100, 'P0-7')
    await outbound(id, 105, 'P0-7 领用')
    let s = await mat(id)
    check('出库后 库存', s.stock, 5)
    const costBefore = s.cost

    const r = await cancelInbound(o._id, 'P0-7 应被拒绝')
    checkTrue('作废被拒绝（返回非成功码）', r.code !== 0, `message=${r.message || ''}`)
    s = await mat(id)
    check('被拒绝后 库存不变', s.stock, 5)
    check('被拒绝后 成本不变', s.cost, costBefore)
  }

  // ================= 场景 8：流水留痕 =================
  scene('场景 8：作废必须留下带成本变化的库存流水')
  {
    const id = await newMaterial('S8', 100, 10)
    const o = await inbound(id, 10, 200, 'P0-8')
    await cancelInbound(o._id, 'P0-8 留痕检查')

    const logs = await query(
      `SELECT change_type, change_quantity, before_stock, after_stock, remark
         FROM stock_logs WHERE material_id = ? AND change_type = 'inbound_cancel'
        ORDER BY id DESC LIMIT 1`,
      [id]
    )
    checkTrue('存在 inbound_cancel 流水', logs.length === 1)
    if (logs.length) {
      const l = logs[0]
      check('流水 变动量', Number(l.change_quantity), -10)
      check('流水 变动前库存', Number(l.before_stock), 110)
      check('流水 变动后库存', Number(l.after_stock), 100)
      checkTrue('流水备注写明成本变化', /成本价/.test(l.remark || ''), `remark=${l.remark}`)
    }
  }

  // ================= 场景 9：出库撤销不误改成本 =================
  scene('场景 9：出库 → 撤销，成本必须一分不动（出库不结转成本）')
  {
    const id = await newMaterial('S9', 100, 10)
    const o = await outbound(id, 20, 'P0-9')
    let s = await mat(id)
    check('出库后 库存', s.stock, 80)
    check('出库后 成本', s.cost, 10)

    await cancelOutbound(o._id)
    s = await mat(id)
    check('撤销后 库存', s.stock, 100)
    check('撤销后 成本（不该动）', s.cost, 10)
  }

  // ================= 场景 10：零漂移压力测试 =================
  scene('场景 10【最强判据】：10 轮「入库 → 作废」，成本必须零漂移')
  {
    const id = await newMaterial('S10', 100, 10)
    const base = await mat(id)
    check('压力测试前 库存', base.stock, 100)
    check('压力测试前 成本', base.cost, 10)

    let drifted = false
    for (let i = 1; i <= 10; i++) {
      const q = 1 + (i * 7) % 20
      const p = 5 + (i * 37) % 480
      const o = await inbound(id, q, p, `P0-10 第 ${i} 轮`)
      const after = await mat(id)
      if (after.stock !== base.stock + q) {
        console.log(`  ✗ 第 ${i} 轮（${q}@${p}）入库后库存 ${after.stock} ≠ ${base.stock + q}`)
        drifted = true
      }
      await cancelInbound(o._id, `P0-10 第 ${i} 轮作废`)
      const back = await mat(id)
      const stockOk = back.stock === base.stock
      const costOk = Math.abs(back.cost - base.cost) <= TOL
      if (!stockOk || !costOk) {
        console.log(`  ✗ 第 ${i} 轮（${q}@${p}）：库存 ${back.stock}（应 ${base.stock}）、成本 ${back.cost}（应 ${base.cost}）`)
        drifted = true
      }
    }
    const final = await mat(id)
    check('10 轮后 库存零漂移', final.stock, base.stock)
    check('10 轮后 成本零漂移（旧实现会一路涨到几十上百）', final.cost, base.cost)
  }

  // ================= 汇总 =================
  const failed = results.filter((r) => r.结果 === '失败')
  console.log('\n' + '='.repeat(64))
  console.log(`  通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    console.log('  失败明细：')
    failed.forEach((f) => console.log(`    ✗ [${f.场景}] ${f.检查项} 实际=${f.实际} 期望=${f.期望}`))
  }
  console.log('='.repeat(64))

  // ---------- 清理 ----------
  if (process.env.KEEP === '1') {
    console.log('\nKEEP=1，保留测试数据（信息如下，供排查）：')
    console.log(`  测试物料 id: ${createdMaterialIds.join(', ')}`)
    console.log(`  入库单 id: ${createdOrderIds.inbound.join(', ')}`)
    console.log(`  出库单 id: ${createdOrderIds.outbound.join(', ')}`)
  } else {
    await cleanup()
    console.log('\n测试数据已清理')
  }

  process.exit(failed.length ? 1 : 0)
}

/** 只清自己造的东西：名字以【测试】P0 开头的物料及其单据、流水 */
async function cleanup() {
  const mats = await query('SELECT id FROM materials WHERE name LIKE ?', [`${PRE}%`])
  const ids = mats.map((m) => m.id)
  if (!ids.length) return
  const ph = ids.map(() => '?').join(',')

  const inOrders = await query(`SELECT id FROM inbound_orders WHERE id IN (${createdOrderIds.inbound.map(() => '?').join(',') || 'NULL'})`, createdOrderIds.inbound)
  const outOrders = await query(`SELECT id FROM outbound_orders WHERE id IN (${createdOrderIds.outbound.map(() => '?').join(',') || 'NULL'})`, createdOrderIds.outbound)

  await withTransaction(async (conn) => {
    await execute(`DELETE FROM stock_logs WHERE material_id IN (${ph})`, ids, conn)
    if (inOrders.length) {
      const p = inOrders.map(() => '?').join(',')
      const oid = inOrders.map((o) => o.id)
      await execute(`DELETE FROM inbound_order_items WHERE order_id IN (${p})`, oid, conn)
      await execute(`DELETE FROM inbound_orders WHERE id IN (${p})`, oid, conn)
    }
    if (outOrders.length) {
      const p = outOrders.map(() => '?').join(',')
      const oid = outOrders.map((o) => o.id)
      await execute(`DELETE FROM outbound_order_items WHERE order_id IN (${p})`, oid, conn)
      await execute(`DELETE FROM outbound_orders WHERE id IN (${p})`, oid, conn)
    }
    await execute(`DELETE FROM materials WHERE id IN (${ph})`, ids, conn)
  })

  const left = await query('SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?', [`${PRE}%`])
  const leftLogs = await query('SELECT COUNT(*) AS c FROM stock_logs')
  console.log(`  复核：残留测试物料 ${left[0].c} 条，库存流水 ${leftLogs[0].c} 条`)
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error('\n[执行失败]', e.message)
    try { await pool.end() } catch (_) { /* ignore */ }
    process.exit(1)
  })
