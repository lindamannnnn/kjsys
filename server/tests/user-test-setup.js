/**
 * ============================================================
 * 4 角色真实使用者测试 · 环境准备脚本
 * ------------------------------------------------------------
 * 作用：把系统置成「可以开始干活」的状态，供 4 个岗位人员测试
 *   1. 建立 4 个真实岗位账号（出库员/采购员/仓管员/老板）
 *   2. 建立一组【测试】开头的专用物料（不污染 1909 条真实物料）
 *   3. 通过真实业务流程灌入初始库存（采购入库 → 仓管确认）
 *   4. 留下几笔待确认单据，让仓管员一上来就有活干
 *   5. 把上下文（账号、物料 ID、单号、初始库存）写成 JSON 供测试使用
 *
 * 幂等：重复执行不会重复建账号/物料（按名称与账号查重）
 * 用法：node tests/user-test-setup.js
 * ============================================================ */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const OUT_FILE = path.join(__dirname, 'user-test-context.json')

/** 统一请求封装 */
function call(moduleName, action, data = {}, token = '', clientRequestId = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      action, data,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {})
    })
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const req = http.request(`${BASE}/api/${moduleName}`,
      { method: 'POST', headers, timeout: 20000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`响应非 JSON：${raw.slice(0, 200)}`)) }
        })
      })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(payload)
    req.end()
  })
}

/** 断言成功，失败直接抛错（准备阶段不吞错） */
async function must(label, p) {
  const res = await p
  if (!res || res.code !== 0) {
    throw new Error(`[${label}] 失败：${res && res.message ? res.message : JSON.stringify(res)}`)
  }
  return res.data
}

// ---------------- 岗位设定 ----------------
const PERSONAS = [
  { username: 'zhangshan', password: 'zs123456', real_name: '张三', roles: ['out'],
    phone: '13800000001', warehouse_ids: [1], post: '车间员工（出库员）' },
  { username: 'lina', password: 'ln123456', real_name: '李娜', roles: ['purchase'],
    phone: '13800000002', warehouse_ids: [1], post: '采购员' },
  { username: 'zhaoliu', password: 'zl123456', real_name: '赵六', roles: ['storekeeper'],
    phone: '13800000003', warehouse_ids: [1], post: '仓管员（配件仓）' },
  { username: 'wangzong', password: 'wz123456', real_name: '王总', roles: ['boss'],
    phone: '13800000004', warehouse_ids: [1, 2], post: '老板' }
]

// ---------------- 测试专用物料 ----------------
// 全部以【测试】开头且规格带 TEST- 前缀，与 1909 条真实物料明确区分，便于清理
const MATERIALS = [
  { key: 'SPK_A',  name: '【测试】火花塞 A型',   spec: 'TEST-SPK-A',  unit: '个', warehouse_id: 1, warning_stock: 20 },
  { key: 'COIL_B', name: '【测试】点火线圈 B型', spec: 'TEST-COIL-B', unit: '个', warehouse_id: 1, warning_stock: 15 },
  { key: 'BRK_C',  name: '【测试】刹车片 C型',   spec: 'TEST-BRK-C',  unit: '套', warehouse_id: 1, warning_stock: 5 },
  { key: 'OIL_D',  name: '【测试】机油滤芯 D型', spec: 'TEST-OIL-D',  unit: '个', warehouse_id: 1, warning_stock: 30 },
  { key: 'AIR_E',  name: '【测试】空气滤芯 E型', spec: 'TEST-AIR-E',  unit: '个', warehouse_id: 1, warning_stock: 30 },
  { key: 'BRG_F',  name: '【测试】轴承 F型',     spec: 'TEST-BRG-F',  unit: '个', warehouse_id: 2, warning_stock: 10 }
]

/** 初始入库（借真实流程灌库存） */
const SEED_INBOUND = [
  { warehouse_id: 1, supplier: '佛山汽配批发中心', items: [
    { key: 'SPK_A',  quantity: 100, unit_price: 12.5 },
    { key: 'COIL_B', quantity: 60,  unit_price: 35 },
    { key: 'BRK_C',  quantity: 3,   unit_price: 88 },
    { key: 'OIL_D',  quantity: 0,   unit_price: 9.9 }   // 数量 0 → 会被拒绝，保留以验证校验
  ] },
  { warehouse_id: 2, supplier: '佛山汽配批发中心', items: [
    { key: 'BRG_F', quantity: 50, unit_price: 22 }
  ] }
]

async function main() {
  console.log('='.repeat(62))
  console.log('  4 角色真实使用者测试 · 环境准备')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(62))

  // ---------- 1. 管理员登录 ----------
  const adminRes = await call('auth', 'adminLogin', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123456'
  })
  if (adminRes.code !== 0) throw new Error(`管理员登录失败：${adminRes.message}`)
  const adminToken = adminRes.data.token
  console.log('\n[1/5] 管理员登录成功')

  // ---------- 2. 建 4 个岗位账号 ----------
  console.log('\n[2/5] 建立岗位账号')
  const tokens = {}
  for (const p of PERSONAS) {
    const list = await call('user', 'list', { keyword: p.username, pageSize: 5 }, adminToken)
    const exists = (list.data && list.data.list || []).some((u) => u.username === p.username)

    if (!exists) {
      await must(`创建 ${p.real_name}`, call('user', 'create', {
        username: p.username, password: p.password, real_name: p.real_name,
        phone: p.phone, roles: p.roles, warehouse_ids: p.warehouse_ids
      }, adminToken))
      console.log(`  ✓ 新建账号 ${p.username}（${p.real_name} / ${p.post}）`)
    } else {
      console.log(`  · 账号 ${p.username}（${p.real_name}）已存在，跳过创建`)
    }

    const r = await call('auth', 'adminLogin', { username: p.username, password: p.password })
    if (r.code !== 0) throw new Error(`${p.real_name} 登录失败：${r.message}`)
    tokens[p.username] = r.data.token
  }

  // ---------- 3. 建测试物料 ----------
  console.log('\n[3/5] 建立测试物料')
  const mats = {}
  for (const m of MATERIALS) {
    const found = await call('material', 'list', { keyword: m.name, pageSize: 5 }, adminToken)
    let row = (found.data && found.data.list || []).find((x) => x.name === m.name)
    if (!row) {
      const created = await must(`创建物料 ${m.name}`, call('material', 'upsert', {
        name: m.name, spec: m.spec, unit: m.unit,
        category: m.warehouse_id === 1 ? '配件' : '成品',
        warehouse_id: m.warehouse_id, warning_stock: m.warning_stock
      }, adminToken))
      row = { _id: created._id, name: m.name }
      console.log(`  ✓ 新建物料 ${m.name}（仓库 ${m.warehouse_id}）`)
    } else {
      console.log(`  · 物料 ${m.name} 已存在（_id=${row._id}）`)
    }
    mats[m.key] = row
  }

  // ---------- 4. 真实流程灌初始库存 ----------
  console.log('\n[4/5] 用真实业务流程灌初始库存（采购提交 → 仓管确认）')
  const seededOrders = []
  for (const seed of SEED_INBOUND) {
    // 过滤掉数量为 0 的项（服务端会拒绝，准备阶段不需要制造失败）
    const items = seed.items
      .filter((it) => it.quantity > 0)
      .map((it) => ({
        material_id: mats[it.key]._id,
        material_name: mats[it.key].name,
        material_spec: MATERIALS.find((x) => x.key === it.key).spec,
        unit: MATERIALS.find((x) => x.key === it.key).unit,
        quantity: it.quantity,
        unit_price: it.unit_price
      }))

    const r = await must(`采购入库（仓库 ${seed.warehouse_id}）`, call('inbound', 'submit', {
      type: 'purchase', warehouse_id: seed.warehouse_id, supplier: seed.supplier,
      remark: '系统初始化：建立测试基线库存', items
    }, tokens.lina))

    // 仓管确认
    await must(`仓管确认入库单`, call('inbound', 'confirm', { id: r._id }, tokens.zhaoliu))
    seededOrders.push({ 单号: r.order_no, 仓库: seed.warehouse_id, 项数: items.length })
    console.log(`  ✓ 入库单 ${r.order_no} 已提交并由赵六确认（${items.length} 项）`)
  }

  // ---------- 5. 留几笔待确认出库单（仓管一上手就有活） ----------
  console.log('\n[5/5] 留下待确认单据供仓管处理')
  const pendingOut = []
  const pendItems = [
    { key: 'SPK_A',  quantity: 10, remark: '维修工单 #1001：更换火花塞' },
    { key: 'COIL_B', quantity: 6,  remark: '维修工单 #1002：更换点火线圈' }
  ]
  for (const it of pendItems) {
    const r = await must(`提交出库（${it.key}）`, call('outbound', 'submit', {
      type: 'repair', warehouse_id: 1, remark: it.remark,
      items: [{
        material_id: mats[it.key]._id,
        material_name: mats[it.key].name,
        material_spec: MATERIALS.find((x) => x.key === it.key).spec,
        unit: MATERIALS.find((x) => x.key === it.key).unit,
        quantity: it.quantity
      }]
    }, tokens.zhangshan))
    pendingOut.push({ 单号: r.order_no, 物料: mats[it.key].name, 数量: it.quantity })
    console.log(`  ✓ 出库单 ${r.order_no}（${mats[it.key].name} × ${it.quantity}，待确认）`)
  }

  // ---------- 输出上下文 ----------
  const materialState = []
  for (const m of MATERIALS) {
    const d = await call('material', 'detail', { id: mats[m.key]._id }, adminToken)
    const mm = d.data || {}
    materialState.push({
      名称: m.name, 规格: m.spec, 仓库: m.warehouse_id,
      _id: mats[m.key]._id, 当前库存: mm.current_stock, 预警值: mm.warning_stock,
      加权成本: mm.avg_cost
    })
  }

  const ctx = {
    生成时间: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    接口地址: BASE,
    岗位账号: PERSONAS.map((p) => ({
      姓名: p.real_name, 岗位: p.post, 账号: p.username, 密码: p.password, 角色: p.roles,
      可管仓库: p.warehouse_ids, token: tokens[p.username]
    })),
    测试物料: materialState,
    初始入库单: seededOrders,
    待确认出库单: pendingOut,
    重要语义: {
      库存变动时机: '出库/入库「提交」时即变动库存；确认、驳回只改状态；撤销、驳回才回补库存',
      幂等: '同一次提交带相同 client_request_id 只会生效一次',
      越权: '按 roles 判权；stats 等模块有 roleRules 限制'
    }
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(ctx, null, 2), 'utf8')

  console.log('\n' + '='.repeat(62))
  console.log('  环境准备完成')
  console.log('='.repeat(62))
  console.log(`  上下文已写入：${OUT_FILE}`)
  console.log('\n  当前库存：')
  materialState.forEach((m) => {
    console.log(`    ${m.名称.padEnd(20)} ${String(m.当前库存).padStart(5)} ${m.规格}  成本 ${m.加权成本}`)
  })
  console.log(`\n  岗位账号：`)
  PERSONAS.forEach((p) => console.log(`    ${p.real_name}  ${p.post.padEnd(18)} ${p.username} / ${p.password}`))
  console.log('')
}

main().catch((e) => {
  console.error('\n[准备失败]', e.message)
  process.exit(1)
})
