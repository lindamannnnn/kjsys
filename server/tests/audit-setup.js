/**
 * ============================================================
 * 4 角色功能审核 · 环境准备脚本（服务器版）
 * ------------------------------------------------------------
 * 与 user-test-setup.js 的区别：
 *   - 目标为已部署服务器，账号独立命名（audit_*），不与历史测试账号混淆
 *   - 物料覆盖两个仓库 + 细分类 + 物料编号，便于验证前端分类筛选
 *   - 库存「补足到基线」语义（幂等，可重复跑，供第 2/3 轮之间补料）
 *   - 额外建立测试供应商（采购流程需要）
 *
 * 用法（在服务器 /opt/shenglong/server 下）：
 *   TEST_BASE=http://127.0.0.1:3000 ADMIN_PASSWORD=xxx node tests/audit-setup.js
 * ============================================================ */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const OUT_FILE = path.join(__dirname, 'audit-context.json')

/** 统一请求封装（与前端 callCloud 同构：POST /api/<module> + {action,data}） */
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
      { method: 'POST', headers, timeout: 25000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`响应非 JSON：${raw.slice(0, 200)}`)) }
        })
      }
    )
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

// ---------------- 岗位设定 ----------------
const PWD = 'Audit@2026'
const PERSONAS = [
  { username: 'audit_out', password: PWD, real_name: '张三', roles: ['out'],
    phone: '13900000001', warehouse_ids: [1], post: '车间员工（出库员）', 只看配件仓: true },
  { username: 'audit_purchase', password: PWD, real_name: '李娜', roles: ['purchase'],
    phone: '13900000002', warehouse_ids: [1], post: '采购员', 只看配件仓: true },
  { username: 'audit_sk', password: PWD, real_name: '赵六', roles: ['storekeeper'],
    phone: '13900000003', warehouse_ids: [1, 2], post: '仓管员（管配件仓与成品仓）', 只看配件仓: false },
  { username: 'audit_boss', password: PWD, real_name: '王总', roles: ['boss'],
    phone: '13900000004', warehouse_ids: [1, 2], post: '老板', 只看配件仓: false }
]

// ---------------- 测试专用物料 ----------------
// 名称统一【测试】前缀 + 规格 TEST- 前缀，与 1906 条真实物料严格隔离，便于清理
const MATERIALS = [
  { key: 'SPK_A',  name: '【测试】火花塞 A型',   spec: 'TEST-SPK-A',  no: 'Z901-001', sub: 'Z901 审核测试备件', unit: '个', warehouse_id: 1, warning_stock: 20, base: 100, price: 12.5 },
  { key: 'COIL_B', name: '【测试】点火线圈 B型', spec: 'TEST-COIL-B', no: 'Z901-002', sub: 'Z901 审核测试备件', unit: '个', warehouse_id: 1, warning_stock: 15, base: 80,  price: 35 },
  { key: 'BRK_C',  name: '【测试】刹车片 C型',   spec: 'TEST-BRK-C',  no: 'Z902-001', sub: 'Z902 审核测试易耗', unit: '套', warehouse_id: 1, warning_stock: 5,  base: 50,  price: 88 },
  { key: 'OIL_D',  name: '【测试】机油滤芯 D型', spec: 'TEST-OIL-D',  no: 'Z902-002', sub: 'Z902 审核测试易耗', unit: '个', warehouse_id: 1, warning_stock: 30, base: 0,   price: 9.9 },
  { key: 'AIR_E',  name: '【测试】空气滤芯 E型', spec: 'TEST-AIR-E',  no: 'Z902-003', sub: 'Z902 审核测试易耗', unit: '个', warehouse_id: 1, warning_stock: 30, base: 30,  price: 15 },
  { key: 'BRG_F',  name: '【测试】轴承 F型',     spec: 'TEST-BRG-F',  no: '',         sub: '审核测试车间',      unit: '个', warehouse_id: 2, warning_stock: 10, base: 40,  price: 22 }
]

const SUPPLIERS = [
  { name: '【测试】佛山汽配批发中心', contact: '陈经理', phone: '0757-88880001', address: '佛山市禅城区' },
  { name: '【测试】广州五金供应站',   contact: '刘主管', phone: '020-66660002',  address: '广州市白云区' }
]

async function main() {
  console.log('='.repeat(64))
  console.log('  4 角色功能审核 · 环境准备')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(64))

  // ---------- 1. 管理员登录 ----------
  const adm = await call('auth', 'adminLogin', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123456'
  })
  if (adm.code !== 0) throw new Error(`管理员登录失败：${adm.message}`)
  const adminToken = adm.data.token
  console.log('\n[1/6] 管理员登录成功')

  // ---------- 2. 建立 4 个岗位账号 ----------
  console.log('\n[2/6] 建立岗位账号')
  const tokens = {}
  for (const p of PERSONAS) {
    const list = await call('user', 'list', { keyword: p.username, pageSize: 10 }, adminToken)
    const found = (list.data && list.data.list || []).find((u) => u.username === p.username)

    if (!found) {
      await must(`创建 ${p.real_name}`, call('user', 'create', {
        username: p.username, password: p.password, real_name: p.real_name,
        phone: p.phone, roles: p.roles, warehouse_ids: p.warehouse_ids
      }, adminToken))
      console.log(`  ✓ 新建 ${p.username}（${p.real_name} / ${p.post}）可管仓库 ${JSON.stringify(p.warehouse_ids)}`)
    } else {
      console.log(`  · ${p.username}（${p.real_name}）已存在，跳过创建`)
    }

    // 登录拿 token；失败则用管理员重置密码后重试（保证脚本可重复跑）
    let r = await call('auth', 'adminLogin', { username: p.username, password: p.password })
    if (r.code !== 0) {
      await must(`重置 ${p.real_name} 密码`, call('user', 'resetPassword', {
        id: found ? found._id : (await call('user', 'list', { keyword: p.username, pageSize: 5 }, adminToken)).data.list[0]._id,
        new_password: p.password
      }, adminToken))
      r = await call('auth', 'adminLogin', { username: p.username, password: p.password })
      if (r.code !== 0) throw new Error(`${p.real_name} 登录失败：${r.message}`)
      console.log(`  ↻ ${p.real_name} 密码已重置并登录成功`)
    }
    tokens[p.username] = r.data.token
  }

  // ---------- 3. 建立测试物料 ----------
  console.log('\n[3/6] 建立测试物料（6 个，覆盖两个仓库）')
  const mats = {}
  for (const m of MATERIALS) {
    const found = await call('material', 'list', { keyword: m.name, pageSize: 20 }, adminToken)
    let row = (found.data && found.data.list || []).find((x) => x.name === m.name)
    if (!row) {
      const created = await must(`创建物料 ${m.name}`, call('material', 'upsert', {
        name: m.name, spec: m.spec, unit: m.unit, material_no: m.no, sub_category: m.sub,
        category: m.warehouse_id === 1 ? '配件' : '成品',
        warehouse_id: m.warehouse_id, warning_stock: m.warning_stock
      }, adminToken))
      row = { _id: created._id, name: m.name }
      console.log(`  ✓ 新建 ${m.name}  仓库${m.warehouse_id}  编号${m.no || '（无）'}  分类「${m.sub}」`)
    } else {
      console.log(`  · ${m.name} 已存在（_id=${row._id}）`)
    }
    mats[m.key] = row
  }

  // ---------- 4. 建立测试供应商 ----------
  console.log('\n[4/6] 建立测试供应商（采购流程需要）')
  for (const s of SUPPLIERS) {
    const list = await call('supplier', 'list', { keyword: s.name, pageSize: 10 }, adminToken)
    const exists = (list.data && list.data.list || []).some((x) => x.name === s.name)
    if (exists) {
      console.log(`  · ${s.name} 已存在`)
    } else {
      await must(`创建供应商 ${s.name}`, call('supplier', 'upsert', s, adminToken))
      console.log(`  ✓ 新建 ${s.name}`)
    }
  }

  // ---------- 5. 「补足到基线库存」（真实流程：采购提交 → 仓管确认）----------
  console.log('\n[5/6] 补足基线库存（真实流程：采购员提交 → 仓管确认）')
  const seededOrders = []
  for (const wh of [1, 2]) {
    const need = []
    for (const m of MATERIALS.filter((x) => x.warehouse_id === wh)) {
      const d = await call('material', 'detail', { id: mats[m.key]._id }, adminToken)
      const cur = Number((d.data && d.data.current_stock) || 0)
      if (m.base > 0 && cur < m.base) {
        need.push({
          material_id: mats[m.key]._id,
          material_name: m.name,
          material_spec: m.spec,
          unit: m.unit,
          quantity: m.base - cur,
          unit_price: m.price
        })
        console.log(`  · ${m.name} 当前 ${cur} < 基线 ${m.base}，需补 ${m.base - cur}`)
      }
    }
    if (!need.length) { console.log(`  · 仓库 ${wh} 库存已达标，无需补料`); continue }

    // 仓库 1 由采购员提交（在其权限范围内）；仓库 2 采购员无权限，
    // 改用老板提交——仅用于准备数据，不代表业务常态
    const submitter = wh === 1 ? tokens.audit_purchase : tokens.audit_boss
    const r = await must(`补料入库（仓库 ${wh}）`, call('inbound', 'submit', {
      type: 'purchase', warehouse_id: wh, supplier: '【测试】佛山汽配批发中心',
      remark: '审核测试：建立基线库存', items: need
    }, submitter))
    await must('仓管确认入库单', call('inbound', 'confirm', { id: r._id }, tokens.audit_sk))
    seededOrders.push({ 单号: r.order_no, 仓库: wh, 项数: need.length })
    console.log(`  ✓ 入库单 ${r.order_no} 提交并由赵六确认（${need.length} 项）`)
  }

  // ---------- 6. 留待处理单据（让仓管一上岗就有活）----------
  console.log('\n[6/6] 留下待处理单据')
  const pendingOut = []
  const pendItems = [
    { key: 'SPK_A',  quantity: 10, remark: '维修工单 #2001：更换火花塞' },
    { key: 'BRK_C',  quantity: 4,  remark: '维修工单 #2002：更换刹车片' }
  ]
  for (const it of pendItems) {
    const m = MATERIALS.find((x) => x.key === it.key)
    const r = await must(`提交出库（${it.key}）`, call('outbound', 'submit', {
      type: 'repair', warehouse_id: 1, remark: it.remark,
      items: [{
        material_id: mats[it.key]._id, material_name: m.name,
        material_spec: m.spec, unit: m.unit, quantity: it.quantity
      }]
    }, tokens.audit_out))
    pendingOut.push({ 单号: r.order_no, 物料: m.name, 数量: it.quantity })
    console.log(`  ✓ 出库单 ${r.order_no}（${m.name} × ${it.quantity}，待仓管确认）`)
  }

  // 一张待确认入库单（让仓管有第二类活）
  const pendIn = await must('提交待确认入库单', call('inbound', 'submit', {
    type: 'purchase', warehouse_id: 1, supplier: '【测试】广州五金供应站',
    remark: '补货到货，等仓管点收',
    items: [{
      material_id: mats.OIL_D._id, material_name: '【测试】机油滤芯 D型',
      material_spec: 'TEST-OIL-D', unit: '个', quantity: 60, unit_price: 9.9
    }]
  }, tokens.audit_purchase))
  console.log(`  ✓ 入库单 ${pendIn.order_no}（机油滤芯 D型 × 60，待仓管确认）`)

  // ---------- 输出上下文 ----------
  const materialState = []
  for (const m of MATERIALS) {
    const d = await call('material', 'detail', { id: mats[m.key]._id }, adminToken)
    const mm = d.data || {}
    materialState.push({
      名称: m.name, 规格: m.spec, 编号: m.no, 细分类: m.sub, 仓库: m.warehouse_id,
      _id: mats[m.key]._id, 当前库存: mm.current_stock, 预警值: mm.warning_stock, 加权成本: mm.avg_cost
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
    待确认入库单: { 单号: pendIn.order_no, 物料: '【测试】机油滤芯 D型', 数量: 60 },
    重要语义: {
      库存变动时机: '出库/入库「提交」时即变动库存；确认、驳回只改状态；撤销、驳回才回补库存',
      幂等: '同一次提交带相同 client_request_id 只会生效一次',
      仓库隔离: 'warehouse_ids 为空=可见全部仓库；非空=只能操作列出的仓库',
      物料前缀: '所有测试物料以【测试】开头，清理脚本据此删除'
    }
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(ctx, null, 2), 'utf8')

  console.log('\n' + '='.repeat(64))
  console.log('  环境准备完成')
  console.log('='.repeat(64))
  console.log(`  上下文已写入：${OUT_FILE}`)
  console.log('\n  当前库存：')
  materialState.forEach((m) => {
    console.log(`    ${m.名称.padEnd(20)} 仓${m.仓库} ${String(m.当前库存).padStart(5)} ${m.单位 || ''}  编号${m.编号 || '-'}  成本 ${m.加权成本}`)
  })
  console.log('\n  岗位账号（密码统一 ' + PWD + '）：')
  PERSONAS.forEach((p) => console.log(`    ${p.real_name}  ${p.post.padEnd(18)} ${p.username.padEnd(16)} 仓库 ${JSON.stringify(p.warehouse_ids)}`))
  console.log('')
}

main().catch((e) => {
  console.error('\n[准备失败]', e.message)
  process.exit(1)
})
