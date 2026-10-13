/**
 * ============================================================
 * 第三轮多岗位真实使用者测试 · 环境准备（V3）
 * ------------------------------------------------------------
 * 与 V2 准备脚本的核心区别：
 *   1. **全部走「模拟微信身份」登录**（dev_openid 直通），不用账号密码登录
 *      —— 这样每个岗位都有 openid，消息投递等链路才能真实测到
 *      （密码登录的账号 openid 为空，消息永远收不到 → 会测出一堆假问题）
 *   2. 待办不再只覆盖「出库 + 采购」，而是**每条流程都留一个起点**，
 *      让 5 个岗位 Agent 一上手就有活干：
 *        出库：pending / picking / receiving 三个状态的单各一张
 *        采购：open / taken / purchased 三个状态的任务各一个
 *        盘点：一张进行中的盘点单（待录入 → 待审核 → 待审批）
 *        入库：不预置（由仓管 Agent 自己发起，测的是「自己开单」这条路径）
 *   3. 输出 v3-test-context.json（含各身份 token、物料 ID、单号）
 *
 * 幂等：物料/账号只在不存在时建；待办单据检测到同标记未完成的就跳过。
 * 用法：node tests/v3-test-setup.js
 * ============================================================
 */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const OUT_FILE = path.join(__dirname, 'v3-test-context.json')
const MARK = '[V3-SETUP]'

/** 统一请求封装（与服务端同样的 {action, data, client_request_id} 信封） */
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

    const req = http.request(`${BASE}/api/${moduleName}`, { method: 'POST', headers, timeout: 20000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch { reject(new Error(`响应非 JSON：${raw.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(payload)
    req.end()
  })
}

async function must(label, p) {
  const res = await p
  if (!res || res.code !== 0) {
    throw new Error(`[${label}] 失败：${res && res.message ? res.message : JSON.stringify(res)}`)
  }
  return res.data
}

async function tryCall(label, p) {
  const res = await p
  return { label, ok: res && res.code === 0, message: res && res.message, data: res && res.data }
}

// ---------------- 模拟身份（与小程序 DEV_IDENTITIES 一致） ----------------
const IDENTITIES = {
  out:      { openid: 'dev_out',      real_name: '张三（模拟）', post: '车间领料员' },
  sk:       { openid: 'dev_sk',       real_name: '赵六（模拟）', post: '仓管员（配件仓+成品仓）' },
  purchase: { openid: 'dev_purchase', real_name: '李娜（模拟）', post: '采购员' },
  boss:     { openid: 'dev_boss',     real_name: '王总（模拟）', post: '老板' }
}

// ---------------- 测试专用物料（与 V2 相同，库里已存在） ----------------
const MATERIALS = [
  { key: 'SPK_A',  name: '【测试】火花塞 A型',  spec: 'TEST-SPK-A',  unit: '个', warehouse_id: 1, warning_stock: 20 },
  { key: 'COIL_B', name: '【测试】点火线圈 B型', spec: 'TEST-COIL-B', unit: '个', warehouse_id: 1, warning_stock: 15 },
  { key: 'BRK_C',  name: '【测试】刹车片 C型',  spec: 'TEST-BRK-C',  unit: '套', warehouse_id: 1, warning_stock: 5 },
  { key: 'OIL_D',  name: '【测试】机油滤芯 D型', spec: 'TEST-OIL-D',  unit: '个', warehouse_id: 1, warning_stock: 30 },
  { key: 'AIR_E',  name: '【测试】空气滤芯 E型', spec: 'TEST-AIR-E',  unit: '个', warehouse_id: 1, warning_stock: 30 },
  { key: 'BRG_F',  name: '【测试】轴承 F型',    spec: 'TEST-BRG-F',  unit: '个', warehouse_id: 2, warning_stock: 10 },
  { key: 'GEAR_G', name: '【测试】齿轮 G型',    spec: 'TEST-GEAR-G', unit: '个', warehouse_id: 2, warning_stock: 8 }
]

/** 基线库存（只在这些物料库存为 0 时才灌，避免重复累加） */
const SEED = {
  1: [
    { key: 'SPK_A',  quantity: 100, unit_price: 12.5 },
    { key: 'COIL_B', quantity: 60,  unit_price: 35 },
    { key: 'BRK_C',  quantity: 20,  unit_price: 88 },
    { key: 'OIL_D',  quantity: 40,  unit_price: 9.9 },
    { key: 'AIR_E',  quantity: 35,  unit_price: 18 }
  ],
  2: [
    { key: 'BRG_F',  quantity: 50, unit_price: 22 },
    { key: 'GEAR_G', quantity: 24, unit_price: 56 }
  ]
}

function matMeta(key) { return MATERIALS.find((x) => x.key === key) }

async function main() {
  console.log('='.repeat(66))
  console.log('  第三轮多岗位真实使用者测试 · 环境准备（V3 · 模拟身份版）')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(66))

  // ---------- 1. 模拟身份登录 ----------
  console.log('\n[1/6] 用「模拟微信身份」登录各岗位（不走真实微信）')
  const tokens = {}
  const users = {}
  for (const [role, id] of Object.entries(IDENTITIES)) {
    const r = await call('auth', 'login', { dev_openid: id.openid, nickname: id.real_name })
    if (r.code !== 0) throw new Error(`${id.post} 模拟登录失败：${r.message}`)
    tokens[role] = r.data.token
    users[role] = r.data.user
    const u = r.data.user || {}
    console.log(`  ✓ ${role.padEnd(9)} ${String(id.openid).padEnd(14)} roles=${JSON.stringify(r.data.roles)} wh=${JSON.stringify(u.warehouse_ids)}`)
  }

  // ---------- 2. 校验测试物料与库存 ----------
  console.log('\n[2/6] 校验测试物料与现有库存')
  const mats = {}
  for (const m of MATERIALS) {
    const found = await call('material', 'list', { keyword: m.name, pageSize: 5 }, tokens.sk)
    const row = ((found.data && found.data.list) || []).find((x) => x.name === m.name) || null
    if (!row) {
      const created = await must(
        `创建物料 ${m.name}`,
        call('material', 'upsert', {
          name: m.name, spec: m.spec, unit: m.unit,
          category: m.warehouse_id === 1 ? '配件' : '成品',
          warehouse_id: m.warehouse_id, warning_stock: m.warning_stock
        }, tokens.sk)
      )
      mats[m.key] = { _id: created._id, name: m.name }
      console.log(`  ✓ 新建物料 ${m.name}（仓库 ${m.warehouse_id}）`)
    } else {
      mats[m.key] = row
    }
  }
  const stock = {}
  for (const m of MATERIALS) {
    const d = await call('material', 'detail', { id: mats[m.key]._id }, tokens.sk)
    stock[m.key] = Number((d.data && d.data.current_stock) || 0)
  }
  console.log('  当前库存：' + MATERIALS.map((m) => `${m.name.replace('【测试】', '')}=${stock[m.key]}`).join('  '))

  // 本轮预置单据对这些物料的消耗量（出库单 A/B/C 合计）。
  // 只有「库存不足以支撑本轮预置单据」时才补货——判据比「库存为 0」实用：
  // 上一轮测试会把库存吃掉一部分，剩 1 个时旧判据会放过去，预置就卡在库存不足上。
  const NEED = { SPK_A: 9, COIL_B: 3, BRK_C: 2, OIL_D: 2, AIR_E: 5 }
  const BUFFER = 5

  let seededAny = false
  for (const wid of [1, 2]) {
    const plan = SEED[wid]
      .map((it) => {
        const now = Number(stock[it.key] || 0)
        const need = (NEED[it.key] || 0) + BUFFER
        if (now > 0 && now >= need) return null
        const target = Math.max(it.quantity, need)
        return { key: it.key, quantity: target - now, unit_price: it.unit_price }
      })
      .filter(Boolean)
    if (!plan.length) continue

    seededAny = true
    const created = await must(
      `入库（仓库 ${wid}）`,
      call('inbound', 'submit', {
        warehouse_id: wid,
        type: 'purchase',
        supplier: '【测试】基线供应商',
        remark: `${MARK} 补充测试基线库存`,
        items: plan.map((it) => ({
          material_id: mats[it.key]._id,
          material_name: mats[it.key].name,
          quantity: it.quantity,
          unit_price: it.unit_price
        }))
      }, tokens.sk, `v3seed-${wid}-${Date.now()}`)
    )
    const inId = created._id || created.id
    await must('入库确认', call('inbound', 'confirm', { id: inId }, tokens.sk))
    console.log(`  ✓ 仓库 ${wid} 已补库存：${plan.map((p) => `${p.key}+${p.quantity}`).join(', ')}`)
  }
  if (!seededAny) console.log('  · 测试物料库存均足以支撑本轮预置，无需补货')
  // 重新读一次
  for (const m of MATERIALS) {
    const d = await call('material', 'detail', { id: mats[m.key]._id }, tokens.sk)
    stock[m.key] = Number((d.data && d.data.current_stock) || 0)
  }
  console.log('  灌后库存：' + MATERIALS.map((m) => `${m.name.replace('【测试】', '')}=${stock[m.key]}`).join('  '))

  // ---------- 3. 出库流程：三个状态的起点 ----------
  console.log('\n[3/6] 预置出库单（pending / picking / receiving 各一张）')
  const existing = await call('outbound', 'list', { page: 1, page_size: 50 }, tokens.sk)
  const openMarked = ((existing.data && existing.data.list) || []).filter(
    (o) => String(o.remark || '').includes(MARK) && !['completed', 'cancelled', 'rejected'].includes(o.status)
  )

  const outOrders = {}
  const submitOne = async (tag, aKey, aQty, bKey, bQty) =>
    must(`提交出库单 ${tag}`, call('outbound', 'submit', {
      warehouse_id: 1,
      type: 'lingyong',
      remark: `${MARK} ${tag}`,
      items: [
        { material_id: mats[aKey]._id, material_name: mats[aKey].name, quantity: aQty, warehouse_id: 1 },
        { material_id: mats[bKey]._id, material_name: mats[bKey].name, quantity: bQty, warehouse_id: 1 }
      ]
    }, tokens.out, `v3out-${tag}-${Date.now()}`))

  const byTag = (tag) => openMarked.find((o) => String(o.remark || '').includes(tag))

  // A. 待确认（什么都不做）
  let a = byTag('出库单A-待确认')
  if (!a) {
    const r = await submitOne('出库单A-待确认', 'SPK_A', 5, 'COIL_B', 3)
    a = { _id: r._id, order_no: r.order_no, status: 'pending' }
    console.log(`  ✓ 待确认单：${a.order_no}`)
  } else console.log(`  · 待确认单已存在：${a.order_no}`)
  outOrders.pending = a

  // B. 待拣货（仓管确认）
  let b = byTag('出库单B-待拣货')
  if (!b) {
    const r = await submitOne('出库单B-待拣货', 'SPK_A', 4, 'OIL_D', 2)
    await must('确认B', call('outbound', 'confirm', { id: r._id }, tokens.sk))
    b = { _id: r._id, order_no: r.order_no, status: 'picking' }
    console.log(`  ✓ 待拣货单：${b.order_no}（已由仓管确认）`)
  } else console.log(`  · 待拣货单已存在：${b.order_no}（状态 ${b.status}）`)
  outOrders.picking = b

  // C. 待收货（仓管确认 + 拣货完成）
  let c = byTag('出库单C-待收货')
  if (!c) {
    const r = await submitOne('出库单C-待收货', 'BRK_C', 2, 'AIR_E', 5)
    await must('确认C', call('outbound', 'confirm', { id: r._id }, tokens.sk))
    await must('拣货C', call('outbound', 'pickDone', { id: r._id }, tokens.sk))
    c = { _id: r._id, order_no: r.order_no, status: 'receiving' }
    console.log(`  ✓ 待收货单：${c.order_no}（已确认 + 已拣货）`)
  } else console.log(`  · 待收货单已存在：${c.order_no}（状态 ${c.status}）`)
  outOrders.receiving = c

  // ---------- 4. 采购流程：三个状态的起点 ----------
  console.log('\n[4/6] 预置采购任务（待领取 / 采购中 / 待收料 各一个）')
  const pExists = await call('purchase', 'list', { page: 1, page_size: 50 }, tokens.sk)
  const pOpen = ((pExists.data && pExists.data.list) || []).filter(
    (t) => String(t.remark || '').includes(MARK) && !['received', 'cancelled'].includes(t.status)
  )
  const pByTag = (tag) => pOpen.find((t) => String(t.remark || '').includes(tag))

  const pCreate = async (tag, wid, key, qty) =>
    must(`发布采购任务 ${tag}`, call('purchase', 'create', {
      warehouse_id: wid,
      remark: `${MARK} ${tag}`,
      items: [{ material_id: mats[key]._id, quantity: qty }]
    }, tokens.sk, `v3pur-${tag}-${Date.now()}`))

  const purchaseTasks = {}
  // D. 待领取
  let d = pByTag('采购D-待领取')
  if (!d) {
    const r = await pCreate('采购D-待领取', 1, 'OIL_D', 20)
    d = { _id: r._id, task_no: r.task_no, status: 'open' }
    console.log(`  ✓ 待领取任务：${d.task_no}`)
  } else console.log(`  · 待领取任务已存在：${d.task_no}`)
  purchaseTasks.open = d

  // E. 采购中（采购员已领取）
  let e = pByTag('采购E-采购中')
  if (!e) {
    const r = await pCreate('采购E-采购中', 1, 'AIR_E', 15)
    await must('领取E', call('purchase', 'take', { id: r._id }, tokens.purchase))
    e = { _id: r._id, task_no: r.task_no, status: 'taken' }
    console.log(`  ✓ 采购中任务：${e.task_no}`)
  } else console.log(`  · 采购中任务已存在：${e.task_no}`)
  purchaseTasks.taken = e

  // F. 待收料（已录入采购信息）
  let f = pByTag('采购F-待收料')
  if (!f) {
    const r = await pCreate('采购F-待收料', 2, 'GEAR_G', 10)
    await must('领取F', call('purchase', 'take', { id: r._id }, tokens.purchase))
    await must('录入F', call('purchase', 'entry', {
      id: r._id,
      purchase_channel: '淘宝',
      external_no: 'TB-TEST-0001',
      items: [{ material_id: mats.GEAR_G._id, quantity: 10, unit_price: 56 }]
    }, tokens.purchase))
    f = { _id: r._id, task_no: r.task_no, status: 'purchased' }
    console.log(`  ✓ 待收料任务：${f.task_no}`)
  } else console.log(`  · 待收料任务已存在：${f.task_no}`)
  purchaseTasks.purchased = f

  // ---------- 5. 盘点流程：一张进行中的盘点单 ----------
  console.log('\n[5/6] 预置进行中的盘点单（成品仓）')
  const cExists = await call('check', 'list', { page: 1, page_size: 50 }, tokens.sk)
  const cOpen = ((cExists.data && cExists.data.list) || []).filter(
    (x) => String(x.remark || '').includes(MARK) && !['completed', 'cancelled'].includes(x.status)
  )
  let checkTask = cOpen[0] || null
  if (!checkTask) {
    const r = await must('创建盘点单', call('check', 'create', {
      type: 'full',
      warehouse_id: 2,
      scope: { material_ids: [mats.BRG_F._id, mats.GEAR_G._id] },
      freeze_stock: false,
      remark: `${MARK} 成品仓盘点（含 2 项测试物料）`
    }, tokens.sk))
    checkTask = { _id: r._id, check_no: r.check_no, status: r.status || 'draft' }
    console.log(`  ✓ 盘点单：${checkTask.check_no}（状态 ${checkTask.status}）`)
  } else {
    console.log(`  · 盘点单已存在：${checkTask.check_no}（状态 ${checkTask.status}）`)
  }

  // ---------- 6. 输出上下文 ----------
  console.log('\n[6/6] 输出上下文 JSON')
  const ctx = {
    generated_at: new Date().toISOString(),
    base: BASE,
    mark: MARK,
    login_mode: 'dev_openid（模拟微信身份，不接真实微信）',
    identities: Object.fromEntries(
      Object.entries(IDENTITIES).map(([role, id]) => [role, {
        openid: id.openid, real_name: id.real_name, post: id.post,
        token: tokens[role],
        roles: (users[role] || {}).roles,
        warehouse_ids: (users[role] || {}).warehouse_ids
      }])
    ),
    materials: Object.fromEntries(
      MATERIALS.map((m) => [m.key, {
        _id: mats[m.key]._id, name: m.name, warehouse_id: m.warehouse_id,
        unit: m.unit, warning_stock: m.warning_stock, stock_now: stock[m.key]
      }])
    ),
    todos: {
      outbound: {
        pending:   { id: outOrders.pending._id,   no: outOrders.pending.order_no,   status: 'pending'   },
        picking:   { id: outOrders.picking._id,   no: outOrders.picking.order_no,   status: 'picking'   },
        receiving: { id: outOrders.receiving._id, no: outOrders.receiving.order_no, status: 'receiving' }
      },
      purchase: {
        open:      { id: purchaseTasks.open._id,      no: purchaseTasks.open.task_no,      status: 'open'      },
        taken:     { id: purchaseTasks.taken._id,     no: purchaseTasks.taken.task_no,     status: 'taken'     },
        purchased: { id: purchaseTasks.purchased._id, no: purchaseTasks.purchased.task_no, status: 'purchased' }
      },
      check: { id: checkTask._id, no: checkTask.check_no, status: checkTask.status, warehouse_id: 2 }
    }
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(ctx, null, 2), 'utf8')
  console.log(`  ✓ 已写出 ${path.relative(process.cwd(), OUT_FILE)}`)

  console.log('\n' + '='.repeat(66))
  console.log('  准备完成。各岗位待办：')
  console.log(`    领料员（dev_out）    ：待收货单 ${ctx.todos.outbound.receiving.no}`)
  console.log(`    仓管员（dev_sk）     ：待确认 ${ctx.todos.outbound.pending.no} / 待拣货 ${ctx.todos.outbound.picking.no}`)
  console.log(`                          待收料 ${ctx.todos.purchase.purchased.no} / 盘点 ${ctx.todos.check.no}`)
  console.log(`    采购员（dev_purchase）：待领取 ${ctx.todos.purchase.open.no} / 采购中 ${ctx.todos.purchase.taken.no}`)
  console.log(`    老板（dev_boss）     ：等盘点提交后审批`)
  console.log('='.repeat(66))
}

main().catch((e) => {
  console.error('\n❌ 准备失败：', e.message)
  process.exit(1)
})
