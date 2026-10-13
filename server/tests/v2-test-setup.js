/**
 * ============================================================
 * 流程重构 V2 · 4 岗位真实使用者测试 · 环境准备
 * ------------------------------------------------------------
 * 与上一版（user-test-setup.js）的差别，全部来自 V2 重构：
 *   1. 「入库员 in」已并入「仓管员 storekeeper」→ 岗位改为 4 个：领料员/采购员/仓管员/老板
 *   2. inbound.submit 不再对采购员开放 → 灌库存改走**新采购任务全流程**
 *      （仓管发布 → 采购员领取 → 填实际单价 → 仓管收料入库）
 *   3. 库存不再是「提交即扣」→ 出库单要走到「待收货」才有真正的扣减
 *   4. 仓管员的仓库权限扩到 [1,2]：V2 里仓管要同时管配件仓和成品仓
 *
 * 干什么：
 *   1. 建/校正 4 个岗位账号（含仓库权限）
 *   2. 建一组【测试】开头的专用物料（配件仓 5 个 + 成品仓 2 个）
 *   3. 用真实业务流程灌基线库存
 *   4. 在四个岗位上各留一批「一上手就有活干」的待办单据
 *   5. 输出上下文 JSON（账号、token、物料、单号）供岗位 Agent 读取
 *
 * 幂等：重复执行不会重复建账号/物料；库存只在为 0 时灌；
 *       待办单据检测到已存在未完成的就跳过
 * 用法：node tests/v2-test-setup.js
 * ============================================================
 */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const OUT_FILE = path.join(__dirname, 'v2-test-context.json')
const MARK = '[V2-SETUP]'

/** 统一请求封装 */
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

async function must(label, p) {
  const res = await p
  if (!res || res.code !== 0) {
    throw new Error(`[${label}] 失败：${res && res.message ? res.message : JSON.stringify(res)}`)
  }
  return res.data
}

/** 允许失败的调用（用于「故意制造失败」的场景） */
async function tryCall(label, p) {
  const res = await p
  return { label, ok: res && res.code === 0, code: res && res.code, message: res && res.message, data: res && res.data }
}

// ---------------- 岗位设定（V2：入库员已并入仓管员） ----------------
const PERSONAS = [
  {
    username: 'zhangshan', password: 'zs123456', real_name: '张三', roles: ['out'],
    phone: '13800000001', warehouse_ids: [1], post: '车间领料员（配件仓）'
  },
  {
    username: 'lina', password: 'ln123456', real_name: '李娜', roles: ['purchase'],
    phone: '13800000002', warehouse_ids: [1, 2], post: '采购员'
  },
  {
    username: 'zhaoliu', password: 'zl123456', real_name: '赵六', roles: ['storekeeper'],
    phone: '13800000003', warehouse_ids: [1, 2], post: '仓管员（配件仓 + 成品仓）'
  },
  {
    username: 'wangzong', password: 'wz123456', real_name: '王总', roles: ['boss'],
    phone: '13800000004', warehouse_ids: [1, 2], post: '老板'
  }
]

// ---------------- 测试专用物料 ----------------
const MATERIALS = [
  { key: 'SPK_A', name: '【测试】火花塞 A型', spec: 'TEST-SPK-A', unit: '个', warehouse_id: 1, warning_stock: 20 },
  { key: 'COIL_B', name: '【测试】点火线圈 B型', spec: 'TEST-COIL-B', unit: '个', warehouse_id: 1, warning_stock: 15 },
  { key: 'BRK_C', name: '【测试】刹车片 C型', spec: 'TEST-BRK-C', unit: '套', warehouse_id: 1, warning_stock: 5 },
  { key: 'OIL_D', name: '【测试】机油滤芯 D型', spec: 'TEST-OIL-D', unit: '个', warehouse_id: 1, warning_stock: 30 },
  { key: 'AIR_E', name: '【测试】空气滤芯 E型', spec: 'TEST-AIR-E', unit: '个', warehouse_id: 1, warning_stock: 30 },
  // 成品仓两个：V2 里仓管要同时管这两仓，出库/采购都要覆盖
  { key: 'BRG_F', name: '【测试】轴承 F型', spec: 'TEST-BRG-F', unit: '个', warehouse_id: 2, warning_stock: 10 },
  { key: 'GEAR_G', name: '【测试】齿轮 G型', spec: 'TEST-GEAR-G', unit: '个', warehouse_id: 2, warning_stock: 8 }
]

/** 基线库存（走真实流程灌） */
const SEED = {
  1: [
    { key: 'SPK_A', quantity: 100, unit_price: 12.5 },
    { key: 'COIL_B', quantity: 60, unit_price: 35 },
    { key: 'BRK_C', quantity: 20, unit_price: 88 },
    { key: 'OIL_D', quantity: 40, unit_price: 9.9 },
    { key: 'AIR_E', quantity: 35, unit_price: 18 }
  ],
  2: [
    { key: 'BRG_F', quantity: 50, unit_price: 22 },
    { key: 'GEAR_G', quantity: 24, unit_price: 56 }
  ]
}

function matMeta(key) {
  return MATERIALS.find((x) => x.key === key)
}

function itemOf(mats, key, quantity) {
  const meta = matMeta(key)
  return {
    material_id: mats[key]._id,
    material_name: mats[key].name,
    material_spec: meta.spec,
    unit: meta.unit,
    quantity
  }
}

async function main() {
  console.log('='.repeat(64))
  console.log('  流程重构 V2 · 4 岗位真实使用者测试 · 环境准备')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(64))

  // ---------- 1. 管理员登录 ----------
  const adminRes = await call('auth', 'adminLogin', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '123456'
  })
  if (adminRes.code !== 0) throw new Error(`管理员登录失败：${adminRes.message}`)
  const adminToken = adminRes.data.token
  console.log('\n[1/6] 管理员登录成功')

  // ---------- 2. 建 / 校正岗位账号 ----------
  console.log('\n[2/6] 建立岗位账号并校正仓库权限')
  const tokens = {}
  for (const p of PERSONAS) {
    const list = await call('user', 'list', { keyword: p.username, pageSize: 5 }, adminToken)
    const row = ((list.data && list.data.list) || []).find((u) => u.username === p.username)

    if (!row) {
      await must(
        `创建 ${p.real_name}`,
        call(
          'user',
          'create',
          {
            username: p.username,
            password: p.password,
            real_name: p.real_name,
            phone: p.phone,
            roles: p.roles,
            warehouse_ids: p.warehouse_ids
          },
          adminToken
        )
      )
      console.log(`  ✓ 新建账号 ${p.username}（${p.real_name} / ${p.post}）`)
    } else {
      // 已存在：把角色与可管仓库校正成 V2 的设定（上一版仓管只有 [1]）
      const r = await tryCall(
        `校正 ${p.real_name}`,
        call(
          'user',
          'updateRole',
          { id: row._id, roles: p.roles, warehouse_ids: p.warehouse_ids },
          adminToken
        )
      )
      if (r.ok) console.log(`  · 账号 ${p.username} 已存在，已校正角色/仓库权限为 ${JSON.stringify(p.warehouse_ids)}`)
      else console.log(`  ! 账号 ${p.username} 权限校正失败：${r.message}`)
    }

    const r = await call('auth', 'adminLogin', { username: p.username, password: p.password })
    if (r.code !== 0) throw new Error(`${p.real_name} 登录失败：${r.message}`)
    tokens[p.username] = r.data.token
  }

  // ---------- 3. 建测试物料 ----------
  console.log('\n[3/6] 建立测试物料')
  const mats = {}
  for (const m of MATERIALS) {
    const found = await call('material', 'list', { keyword: m.name, pageSize: 5 }, adminToken)
    let row = (((found.data && found.data.list) || []).find((x) => x.name === m.name)) || null
    if (!row) {
      const created = await must(
        `创建物料 ${m.name}`,
        call(
          'material',
          'upsert',
          {
            name: m.name,
            spec: m.spec,
            unit: m.unit,
            category: m.warehouse_id === 1 ? '配件' : '成品',
            warehouse_id: m.warehouse_id,
            warning_stock: m.warning_stock
          },
          adminToken
        )
      )
      row = { _id: created._id, name: m.name }
      console.log(`  ✓ 新建物料 ${m.name}（仓库 ${m.warehouse_id}）`)
    } else {
      console.log(`  · 物料 ${m.name} 已存在（_id=${row._id}）`)
    }
    mats[m.key] = row
  }

  // ---------- 4. 灌基线库存 ----------
  // 仓库 1 走「采购任务」全流程（V2 新链路，顺便验证它自己能跑通）
  // 仓库 2 走仓管的直接入库（仓管有 inbound.submit 权限）
  console.log('\n[4/6] 灌基线库存（库存为 0 的才灌，避免重复累加）')
  const stockBefore = await readStock(mats, adminToken)
  const seeded = []

  for (const wid of [1, 2]) {
    const pending = SEED[wid].filter((it) => Number(stockBefore[it.key] || 0) <= 0)
    if (!pending.length) {
      console.log(`  · 仓库 ${wid} 的测试物料已有库存，跳过`)
      continue
    }

    if (wid === 1) {
      // ① 仓管发布采购任务
      const created = await must(
        '发布采购任务',
        call(
          'purchase',
          'create',
          {
            warehouse_id: 1,
            remark: `${MARK} 建立测试基线库存`,
            items: pending.map((it) => ({ material_id: mats[it.key]._id, quantity: it.quantity }))
          },
          tokens.zhaoliu
        )
      )
      // ② 采购员领取
      await must('采购员领取任务', call('purchase', 'take', { id: created._id }, tokens.lina))
      // ③ 采购员录入实际单价
      await must(
        '采购录入',
        call(
          'purchase',
          'entry',
          {
            id: created._id,
            purchase_channel: '线下',
            external_no: `SETUP-${wid}-${Date.now()}`,
            remark: `${MARK} 基线库存`,
            items: pending.map((it) => ({ material_id: mats[it.key]._id, unit_price: it.unit_price }))
          },
          tokens.lina
        )
      )
      // ④ 仓管收料入库（此刻库存才增加）
      await must('收料入库', call('purchase', 'receive', { id: created._id }, tokens.zhaoliu))
      seeded.push({ 渠道: '采购任务全流程', 仓库: wid, 任务号: created.task_no, 项数: pending.length })
      console.log(`  ✓ 采购任务 ${created.task_no}（仓库 ${wid}，${pending.length} 项）已走完全流程入库`)
    } else {
      const items = pending.map((it) => ({
        ...itemOf(mats, it.key, it.quantity),
        unit_price: it.unit_price
      }))
      const r = await must(
        `仓管直接入库（仓库 ${wid}）`,
        call(
          'inbound',
          'submit',
          {
            type: 'purchase',
            warehouse_id: wid,
            supplier: '佛山汽配批发中心',
            remark: `${MARK} 建立测试基线库存`,
            items
          },
          tokens.zhaoliu
        )
      )
      await must('仓管确认入库单', call('inbound', 'confirm', { id: r._id }, tokens.zhaoliu))
      seeded.push({ 渠道: '仓管直接入库', 仓库: wid, 单号: r.order_no, 项数: items.length })
      console.log(`  ✓ 入库单 ${r.order_no}（仓库 ${wid}，${items.length} 项）已确认入库`)
    }
  }

  // ---------- 5. 在四个岗位上各留一批待办 ----------
  console.log('\n[5/6] 造待处理单据（让每个岗位一上手就有活干）')
  const todos = { 张三: [], 李娜: [], 赵六: [], 王总: [] }

  const existing = await findOpenSetupOrders(tokens.wangzong)
  if (existing.length) {
    console.log(`  · 检测到 ${existing.length} 张未完成的测试单据，跳过造单（避免越堆越多）`)
  } else {
    // (a) 张三提交 → 停在「待确认」，等赵六确认
    const o1 = await must(
      '张三提交领料单（待确认）',
      call(
        'outbound',
        'submit',
        {
          warehouse_id: 1,
          type: 'lingyong',
          remark: `${MARK} 维修工单 #1001：更换火花塞`,
          items: [itemOf(mats, 'SPK_A', 10)]
        },
        tokens.zhangshan
      )
    )
    todos.张三.push({ 单号: o1.order_no, 状态: '待确认', 该谁处理: '赵六' })
    todos.赵六.push({ 单号: o1.order_no, 状态: '待确认', 动作: '确认或驳回' })

    // (b) 张三提交 → 赵六确认 → 赵六拣货完成 → 停在「待收货」，等张三收货（V2 核心链路）
    const o2 = await must(
      '张三提交领料单（要走完到待收货）',
      call(
        'outbound',
        'submit',
        {
          warehouse_id: 1,
          type: 'lingyong',
          remark: `${MARK} 维修工单 #1002：更换点火线圈`,
          items: [itemOf(mats, 'COIL_B', 6)]
        },
        tokens.zhangshan
      )
    )
    await must('赵六确认', call('outbound', 'confirm', { id: o2._id }, tokens.zhaoliu))
    await must('赵六拣货完成', call('outbound', 'pickDone', { id: o2._id }, tokens.zhaoliu))
    todos.张三.push({ 单号: o2.order_no, 状态: '待收货', 该谁处理: '张三（确认收货后才扣库存）' })
    todos.赵六.push({ 单号: o2.order_no, 状态: '待收货', 动作: '可代确认收货' })

    // (c) 张三提交 → 赵六确认 → 停在「待拣货」，等赵六拣货
    const o3 = await must(
      '张三提交领料单（待拣货）',
      call(
        'outbound',
        'submit',
        {
          warehouse_id: 2,
          type: 'lingyong',
          remark: `${MARK} 车间急用：齿轮`,
          items: [itemOf(mats, 'GEAR_G', 4)]
        },
        tokens.wangzong
      )
    )
    await must('赵六确认（成品仓）', call('outbound', 'confirm', { id: o3._id }, tokens.zhaoliu))
    todos.赵六.push({ 单号: o3.order_no, 状态: '待拣货', 动作: '拣货完成' })
    todos.王总.push({ 单号: o3.order_no, 状态: '待拣货', 说明: '成品仓出库单，可观察它是否卡住' })

    // (d) 赵六发布采购任务（不指定人）→ 停在「待领取」，等李娜领取
    const p1 = await must(
      '赵六发布采购任务（待领取）',
      call(
        'purchase',
        'create',
        {
          warehouse_id: 1,
          remark: `${MARK} 刹车片库存偏低，安排采购`,
          items: [{ material_id: mats.BRK_C._id, quantity: 15 }]
        },
        tokens.zhaoliu
      )
    )
    todos.李娜.push({ 任务号: p1.task_no, 状态: '待领取', 动作: '领取 + 采购录入' })
    todos.赵六.push({ 任务号: p1.task_no, 状态: '待领取', 说明: '已发布，等采购员领取' })

    // (e) 赵六指定李娜 → 李娜领取并录入 → 停在「待收料」，等赵六收料
    const p2 = await must(
      '赵六发布采购任务（指定李娜）',
      call(
        'purchase',
        'create',
        {
          warehouse_id: 2,
          assignee_openid: undefined,
          remark: `${MARK} 成品仓轴承补货`,
          items: [{ material_id: mats.BRG_F._id, quantity: 20 }]
        },
        tokens.zhaoliu
      )
    )
    await must('李娜领取', call('purchase', 'take', { id: p2._id }, tokens.lina))
    await must(
      '李娜采购录入',
      call(
        'purchase',
        'entry',
        {
          id: p2._id,
          purchase_channel: '淘宝',
          external_no: `TB-${Date.now()}`,
          remark: `${MARK} 已下单待收货`,
          items: [{ material_id: mats.BRG_F._id, unit_price: 23.5 }]
        },
        tokens.lina
      )
    )
    todos.赵六.push({ 任务号: p2.task_no, 状态: '待收料', 动作: '收料入库 或 退回' })
    todos.李娜.push({ 任务号: p2.task_no, 状态: '待收料', 说明: '已录入，等仓管收料；若被退回需重填' })

    console.log(`  ✓ 已造 ${todos.张三.length + todos.赵六.length + todos.李娜.length + todos.王总.length} 条待办`)
  }

  // ---------- 6. 记录基线并写上下文 ----------
  console.log('\n[6/6] 记录库存基线，输出上下文')
  const stockAfter = await readStock(mats, adminToken)
  const materialState = MATERIALS.map((m) => ({
    名称: m.name,
    规格: m.spec,
    仓库: m.warehouse_id,
    _id: mats[m.key]._id,
    当前库存: stockAfter[m.key],
    预警值: m.warning_stock
  }))

  const ctx = {
    生成时间: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    接口地址: BASE,
    数据标记: MARK,
    岗位账号: PERSONAS.map((p) => ({
      姓名: p.real_name,
      岗位: p.post,
      账号: p.username,
      密码: p.password,
      角色: p.roles,
      可管仓库: p.warehouse_ids,
      token: tokens[p.username]
    })),
    测试物料: materialState,
    灌库存方式: seeded,
    待办清单: todos,
    基线库存: stockAfter,
    重要语义: {
      库存变动时机:
        'V2：出库单在「确认收货」那一刻才扣库存（此前提交/确认/拣货都不动库存）；采购任务在仓管「收料入库」时才增加库存',
      出库四阶段: 'pending 待确认 → picking 待拣货 → receiving 待收货 → completed 已完成',
      采购四阶段: 'open 待领取 → taken 采购中 → purchased 待收料 → received 已入库',
      驳回与作废:
        '待确认/待拣货/待收货都能驳回（这三态库存未扣，不涉及回补）；已完成要管理员才能作废，作废会回补库存',
      角色: 'out 领料员 / purchase 采购员 / storekeeper 仓管员 / boss 老板 / admin 管理员；原「入库员 in」已废弃并入仓管员',
      购买方式: '淘宝 / 京东 / 线下 / 其他',
      幂等: '同一次提交带相同 client_request_id 只会生效一次',
      仓库: '配件仓 = peijian 或 id 1；成品仓 = chengpin 或 id 2'
    }
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(ctx, null, 2), 'utf8')

  console.log('\n' + '='.repeat(64))
  console.log('  环境准备完成')
  console.log('='.repeat(64))
  console.log(`  上下文已写入：${OUT_FILE}`)
  console.log('\n  当前库存：')
  materialState.forEach((m) => {
    console.log(`    ${m.名称.padEnd(18)} 仓${m.仓库}  ${String(m.当前库存).padStart(5)}  ${m.规格}`)
  })
  console.log('\n  岗位账号：')
  PERSONAS.forEach((p) => {
    console.log(`    ${p.real_name}  ${p.post.padEnd(24)} ${p.username} / ${p.password}  可管仓库 ${JSON.stringify(p.warehouse_ids)}`)
  })
  console.log('\n  待办：')
  for (const [who, list] of Object.entries(todos)) {
    list.forEach((t) => console.log(`    ${who}：${t.任务号 || t.单号}  ${t.状态}`))
  }
  console.log('')
}

/** 读取全部测试物料的当前库存 */
async function readStock(mats, token) {
  const out = {}
  for (const m of MATERIALS) {
    const d = await call('material', 'detail', { id: mats[m.key]._id }, token)
    out[m.key] = d && d.data ? d.data.current_stock : null
  }
  return out
}

/** 是否已存在未完成的测试单据（幂等护栏） */
async function findOpenSetupOrders(token) {
  const found = []
  for (const status of ['pending', 'picking', 'receiving']) {
    const r = await call('outbound', 'list', { status, pageSize: 100 }, token)
    const rows = (r.data && r.data.list) || []
    rows.forEach((o) => {
      if (String(o.remark || '').includes(MARK)) found.push(o.order_no)
    })
  }
  return found
}

main().catch((e) => {
  console.error('\n[准备失败]', e.message)
  process.exit(1)
})
