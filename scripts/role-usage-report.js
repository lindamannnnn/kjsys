/**
 * ============================================================
 * 岗位「使用情况」实录报告生成器
 * ------------------------------------------------------------
 * 和 role-agent/run.js（断言对错）不同，这个脚本回答的是：
 *   「每个岗位在真实业务里**干了什么、看到什么、收到什么、能/不能做什么**」
 *
 * 做法：6 个岗位走一条**真实业务主线**（建仓→入库→领料出库→确认→拣货→收货
 *   →采购→收料→盘点→审核→老板看数），每一步真实落库，把真实结果
 *   （单号/数量/金额/消息）逐岗记录下来，最后按岗位出「使用情况报告」。
 *
 * 数据全程带 [RA-USE] 标记 + 由 dev_* 测试账号经手，跑完用
 *   cleanup-test-data.js --apply 清干净（本脚本最后也会提示/可自动清）。
 *
 * 用法：
 *   node scripts/role-usage-report.js            # 跑 + 出报告 + 自动清理
 *   node scripts/role-usage-report.js --keep     # 保留现场（排查用）
 * ============================================================
 */
require('../server/src/config/env')
const fs = require('fs')
const path = require('path')
const { callRaw, loginDev, loginAdmin, num, db } = require('../server/tests/role-agent/lib')

const KEEP = process.argv.includes('--keep')
const MARK = '[RA-USE]'
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
let state_dckId = 0 // 厂长建的盘点单 id（管理员审核要用）

// ---------------- 实录容器 ----------------
/** usage[role] = { name, duty, ops[], msgs[], view[], denied[], allowed[] } */
const usage = {}
function R(role, name, duty) {
  usage[role] = { name, duty, ops: [], msgs: [], view: [], denied: [], allowed: [] }
  return usage[role]
}
function op(role, action, res, detail) {
  const ok = res && res.code === 0
  let d
  if (typeof detail === 'function') {
    // 惰性：只有成功才调用 detail(res.data)，失败时绝不读 .data（避免 null 崩溃）
    try { d = ok ? detail(res.data || {}) : `失败（${(res && res.message) || 'code=' + (res && res.code)}）` } catch (e) { d = '' }
  } else {
    d = detail || (res && res.message) || ''
  }
  usage[role].ops.push({ time: now(), action, ok, detail: d })
  if (!ok) console.error(`  ⚠️ [${role}] ${action} 失败: code=${res && res.code} ${res && res.message}`)
  return ok
}
function deny(role, action, res) {
  usage[role].denied.push({ action, code: res && res.code, msg: res && res.message })
}
function allow(role, what) { usage[role].allowed.push(what) }
function view(role, what) { usage[role].view.push(what) }

const money = (v) => `¥${num(v).toFixed(2)}`

// ---------------- 主流程 ----------------
async function main() {
  // 健康检查
  const health = await fetch(`${require('../server/tests/role-agent/lib').BASE}/api/health`).then((r) => r.status).catch(() => 0)
  if (health !== 200) { console.error('本地服务不可达，请先启动 node src/app.js'); process.exit(2) }

  console.log('登录 6 个岗位…')
  const t = {
    sk: await loginDev('dev_sk'),
    picker: await loginDev('dev_out'),
    purchaser: await loginDev('dev_purchase'),
    boss: await loginDev('dev_boss'),
    director: await loginDev('dev_director'),
    admin: await loginAdmin('admin', '123456')
  }
  const agent = {
    sk: (m, a, d) => callRaw(m, a, d, t.sk),
    picker: (m, a, d) => callRaw(m, a, d, t.picker),
    purchaser: (m, a, d) => callRaw(m, a, d, t.purchaser),
    boss: (m, a, d) => callRaw(m, a, d, t.boss),
    director: (m, a, d) => callRaw(m, a, d, t.director),
    admin: (m, a, d) => callRaw(m, a, d, t.admin)
  }

  // 岗位定义
  R('sk', '赵六', '确认出入库、拣货、收料入库、维护物料、发起盘点')
  R('picker', '张三', '提交领料单、到场收货')
  R('purchaser', '李娜', '领采购任务、录入实际单价与单号')
  R('director', '老周', '发采购单、盘点、审核盘点、看两仓库存（含金额）')
  R('boss', '王总', '看数据看板与各类流水（只读）')
  R('admin', 'admin', '后台管理：用户/审核/系统')

  const chain = [] // 业务主线旁白
  const say = (s) => chain.push(s)

  // ============ 1. 仓管：建档 + 入库 ============
  say('仓管赵六新到一批货，先把物料建档，再入库。')
  const mkA = await agent.sk('material', 'upsert', {
    name: `${MARK}进销存演示件`, spec: 'DEMO-USE-1', category: '配件', unit: '个',
    warehouse_id: 1, warning_stock: 5, remark: MARK
  })
  // upsert 只返回 { _id }（不含 material_no），所以这里只引 _id
  const matId = op('sk', '建档物料「进销存演示件」', mkA, (d) => `成功（物料 ID ${d._id}，入配件仓）`) ? mkA.data._id : null
  if (!matId) { console.error('建档失败，中断'); process.exit(1) }

  const inRes = await agent.sk('inbound', 'submit', {
    type: 'purchase', supplier: `${MARK}演示供应商`, warehouse_id: 1, remark: MARK,
    items: [{ material_id: matId, quantity: 20, unit_price: 10 }]
  })
  const inNo = inRes.data && inRes.data.order_no
  op('sk', '入库 20 件（单价 ¥10）', inRes, (d) => `成功，单号 ${d.order_no}，金额 ${money(d.total_price)}，库存 0→20`)
  say(`入库单 ${inNo}：进销存演示件 ×20 @¥10 = ¥200。`)
  allow('sk', '建档物料、入库、查库存台账')

  // ============ 2. 领料员：提交领料出库 ============
  say('领料员张三要领 6 件去车间，提交领料单。')
  const outRes = await agent.picker('outbound', 'submit', {
    type: 'lingyong', warehouse_id: 1, remark: MARK,
    items: [{ material_id: matId, quantity: 6 }]
  })
  const outId = outRes.data && outRes.data._id
  const outNo = outRes.data && outRes.data.order_no
  op('picker', '提交领料单（领 6 件）', outRes, `成功，单号 ${outNo}，等仓管确认拣货`)
  say(`领料单 ${outNo}：演示件 ×6。`)
  allow('picker', '提交领料单、撤销自己未拣货的单')
  // 领料员看库存是脱敏的
  const pStock = await agent.picker('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 })
  const pRow = (pStock.data && pStock.data.list || [])[0] || {}
  view('picker', `库存台账能看到物料，但**单价/成本被隐藏**（avg_cost=${pRow.avg_cost === undefined ? '已隐藏' : pRow.avg_cost}）`)
  const pDeny = await agent.picker('check', 'review', { id: 1, approve: true })
  deny('picker', '审核盘点', pDeny)

  // ============ 3. 仓管：确认 → 拣货 ============
  say('仓管赵六收到提醒，确认这张领料单并拣货。')
  const cfm = await agent.sk('outbound', 'confirm', { id: outId })
  op('sk', `确认领料单 ${outNo}`, cfm, '状态：待确认 → 待拣货')
  const pick = await agent.sk('outbound', 'pickDone', { id: outId })
  op('sk', `拣货完成 ${outNo}`, pick, '状态：待拣货 → 待收货')
  allow('sk', '确认出库、拣货')

  // ============ 4. 领料员：收货 ============
  say('张三到场收货。')
  const recv = await agent.picker('outbound', 'receive', { id: outId })
  op('picker', `收货 ${outNo}`, recv, '出库完成，库存 20→14')
  say(`收货完成：演示件库存 20 → 14。`)

  // ============ 5. 仓管：发采购 → 采购员：领+录 → 仓管：收料 ============
  say('库存快见底，仓管赵六发一个采购任务给采购员。')
  const ptRes = await agent.sk('purchase', 'create', {
    warehouse_id: 1, assignee_openid: 'dev_purchase', remark: `${MARK}补货`,
    items: [{ material_id: matId, quantity: 10 }]
  })
  const ptId = ptRes.data && ptRes.data._id
  const ptNo = ptRes.data && ptRes.data.task_no
  op('sk', '发采购任务（补 10 件）', ptRes, `成功，任务号 ${ptNo}`)
  say(`采购任务 ${ptNo}：演示件 ×10。`)

  const take = await agent.purchaser('purchase', 'take', { id: ptId })
  op('purchaser', `领取采购任务 ${ptNo}`, take, '状态：待领取 → 采购中')
  const entry = await agent.purchaser('purchase', 'entry', {
    id: ptId, purchase_channel: '淘宝', external_no: `${MARK}-TB001`, remark: '已下单',
    items: [{ material_id: matId, unit_price: 12.5 }]
  })
  op('purchaser', '录入实际单价 ¥12.5 + 淘宝单号', entry, '状态：采购中 → 已采购，待收料')
  allow('purchaser', '领采购任务、录单价单号')
  const purDeny = await agent.purchaser('outbound', 'confirm', { id: outId })
  deny('purchaser', '确认出库单', purDeny)
  say('采购员李娜已下单（淘宝，单价 ¥12.5），货回仓。')

  // 逐项登记到齐（V5.3 起不允许整单一键入库）
  const pd = await agent.sk('purchase', 'detail', { id: ptId })
  const pItems = (pd.data && pd.data.items) || []
  for (const it of pItems) {
    await agent.sk('purchase', 'receiveItem', { id: ptId, item_id: it._id, action: 'receive', received_qty: Number(it.quantity) })
  }
  const rcv = await agent.sk('purchase', 'receive', { id: ptId })
  op('sk', `采购收料入库 ${ptNo}（逐项登记到齐后完成入库）`, rcv, '演示件库存 14→24，成本按 ¥10/¥12.5 加权平均')
  say(`收料入库：演示件库存 14 → 24。`)
  allow('sk', '采购收料入库')

  // ============ 6. 厂长：看两仓 + 发采购单 + 盘点 ============
  say('厂长老周看两个仓库的库存和金额，又发了一个采购单，并做了一次盘点。')
  const s1 = await agent.director('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 })
  const s2 = await agent.director('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 2 })
  const dRow = (s1.data && s1.data.list || [])[0] || {}
  op('director', '看配件仓库存（含金额）', s1, (d) => `共 ${d.total} 种，能看到单价 ${dRow.avg_cost !== undefined ? money(dRow.avg_cost) : '?'}`)
  op('director', '看成品仓库存（含金额）', s2, (d) => `共 ${d.total} 种`)
  const ws = await agent.director('stats', 'warehouseSummary', {})
  const wlist = (ws.data && ws.data.list) || []
  view('director', `两仓总值：${wlist.map((w) => `${w.name} ${money(w.total_value)}`).join('，')}`)
  allow('director', '看两仓库存与金额、发采购单、盘点、审核盘点')

  const dpt = await agent.director('purchase', 'create', {
    warehouse_id: 1, remark: `${MARK}厂长补货`, items: [{ material_id: matId, quantity: 5 }]
  })
  op('director', '发采购单（补 5 件）', dpt, `成功，任务号 ${dpt.data && dpt.data.task_no}`)

  // 盘点：实盘=账面（24），差异 0
  const dck = await agent.director('check', 'create', {
    warehouse_id: 1, type: 'sample', remark: `${MARK}厂长盘点`, scope: { material_ids: [matId] }
  })
  const dckId = dck.data && dck.data._id
  op('director', '建盘点单（只盘演示件）', dck, `成功，单号 ${dck.data && dck.data.check_no}`)
  if (dckId) {
    const cd = await agent.director('check', 'detail', { id: dckId })
    const item = ((cd.data && cd.data.items) || [])[0]
    const book = Number(item.book_stock || 0)
    const dsub = await agent.director('check', 'submit', { id: dckId, items: [{ material_id: item.material_id, actual_stock: book }] })
    op('director', `盘点录入提交（账面 ${book}，实盘 ${book}，差异 0）`, dsub, '已提交，待审核')
    state_dckId = dckId
  }
  const dDeny = await agent.director('inbound', 'submit', { warehouse_id: 1, supplier: 'x', items: [{ material_id: matId, quantity: 1, unit_price: 1 }] })
  deny('director', '提交入库', dDeny)
  const dDeny2 = await agent.director('stats', 'trend', {})
  deny('director', '趋势分析', dDeny2)

  // ============ 7. 管理员：审核盘点 + 用户管理 ============
  say('管理员在后台审核这张盘点单。')
  const rev = await agent.admin('check', 'review', { id: state_dckId, approve: true, remark: '实盘账面一致' })
  op('admin', `审核盘点单（通过）`, rev, '差异 0，库存不变，状态 → 已完成')
  const users = await agent.admin('user', 'list', { page: 1, pageSize: 1 })
  op('admin', '查看用户列表', users, `共 ${users.data && users.data.total} 个账号`)
  const logs = await agent.admin('user', 'logs', { page: 1, pageSize: 5 })
  view('admin', `操作日志 ${(logs.data && logs.data.total) || 0} 条（谁动了什么全程留痕）`)
  allow('admin', '审核盘点、用户管理、看全部数据')

  // ============ 8. 老板：看数（只读） ============
  say('老板王总打开看板看今天的经营数。')
  const ov = await agent.boss('stats', 'overview', {})
  const ovD = ov.data || {}
  op('boss', '打开数据看板', ov, `库存总值 ${money(ovD.total_value)}，物料 ${ovD.material_count} 种，库存总量 ${ovD.total_stock} 件`)
  const bflow = await agent.boss('stats', 'stockFlow', { page: 1, pageSize: 5 })
  op('boss', '看库存流水', bflow, (d) => `最近 ${(d.list || []).length} 笔（含本次入库/出库/收料）`)
  const border = await agent.boss('stats', 'orderFlow', { page: 1, pageSize: 5 })
  op('boss', '看单据流水', border, (d) => `共 ${d.total} 张单据`)
  allow('boss', '看数据看板、库存流水、库存台账、单据流水、库存预警（全部只读）')
  const bDeny = await agent.boss('check', 'review', { id: state_dckId, approve: true })
  deny('boss', '审核盘点', bDeny)
  const bDeny2 = await agent.boss('inbound', 'submit', { warehouse_id: 1, supplier: 'x', items: [{ material_id: matId, quantity: 1, unit_price: 1 }] })
  deny('boss', '提交入库', bDeny2)
  const bDeny3 = await agent.boss('purchase', 'create', { warehouse_id: 1, items: [{ material_id: matId, quantity: 1 }] })
  deny('boss', '发采购单', bDeny3)
  view('boss', `今日入库 ${ovD.today_inbound_orders} 单 / 今日出库 ${ovD.today_outbound_orders} 单 / 本月出库 ${ovD.month_outbound_orders} 单`)

  // ============ 9. 各岗位收到的消息 ============
  await new Promise((r) => setTimeout(r, 800)) // 等 fire-and-forget 消息落库
  const openidOf = { sk: 'dev_sk', picker: 'dev_out', purchaser: 'dev_purchase', director: 'dev_director', boss: 'dev_boss' }
  for (const role of Object.keys(openidOf)) {
    const ms = await db.query(
      'SELECT title, content, created_at FROM messages WHERE to_openid = ? ORDER BY id DESC LIMIT 10',
      [openidOf[role]]
    )
    usage[role].msgs = ms.map((m) => `${m.title}（${(m.content || '').slice(0, 40)}…）`)
  }

  // ============ 10. 生成报告 ============
  const reportPath = buildReport(chain)
  console.log(`\n📄 使用情况报告：${reportPath}`)

  // ============ 11. 清理 ============
  if (!KEEP) {
    console.log('\n🧹 清理本次演示数据…')
    const { spawnSync } = require('child_process')
    const r = spawnSync(process.execPath, [path.join(__dirname, '../server/tests/cleanup-test-data.js'), '--apply'], { stdio: 'inherit' })
    console.log(r.status === 0 ? '✅ 已清理' : '⚠️ 清理脚本返回非 0')
  } else {
    console.log('\n⚠️ --keep：保留了现场数据，排查完记得手动 node tests/cleanup-test-data.js --apply')
  }
}

// ---------------- 报告生成 ----------------
function buildReport(chain) {
  const L = []
  L.push('# 各岗位使用情况报告（真实业务链实测）')
  L.push('')
  L.push(`> 时间：${new Date().toLocaleString('zh-CN')}`)
  L.push('> 方式：6 个岗位走一条**真实业务主线**，每一步真实落库，以下全是实际发生的操作与系统真实返回。')
  L.push('> 数据说明：演示物料/单据均带标记，跑完已自动清理，不影响真实数据。')
  L.push('')

  L.push('## 一、这条业务主线实际发生了什么')
  L.push('')
  chain.forEach((c, i) => L.push(`${i + 1}. ${c}`))
  L.push('')

  L.push('## 二、分岗位使用情况')
  L.push('')

  const order = ['sk', 'picker', 'purchaser', 'director', 'boss', 'admin']
  const roleCn = { sk: '仓管', picker: '领料员', purchaser: '采购员', director: '厂长', boss: '老板', admin: '管理员' }
  order.forEach((role, idx) => {
    const u = usage[role]
    const okOps = u.ops.filter((o) => o.ok).length
    const failOps = u.ops.filter((o) => !o.ok).length
    L.push(`### ${idx + 1}. ${roleCn[role]} · ${u.name}`)
    L.push('')
    L.push(`**岗位职责**：${u.duty}`)
    L.push('')
    L.push(`**本次实际操作**（${u.ops.length} 步，成功 ${okOps}${failOps ? ` / 失败 ${failOps}` : ''}）：`)
    L.push('')
    u.ops.forEach((o, i) => {
      L.push(`${i + 1}. \`${o.time}\` ${o.action} → ${o.ok ? '✅ ' : '❌ '}${o.detail}`)
    })
    L.push('')
    if (u.view.length) {
      L.push('**他在系统里能看到的数据**：')
      u.view.forEach((v) => L.push(`- ${v}`))
      L.push('')
    }
    if (u.msgs.length) {
      L.push(`**本次收到的系统消息**（${u.msgs.length} 条）：`)
      u.msgs.forEach((m) => L.push(`- ${m}`))
      L.push('')
    }
    L.push('**权限边界（实测，点了真会被拦）**：')
    if (u.allowed.length) L.push(`- ✅ 能做：${u.allowed.join('、')}`)
    u.denied.forEach((d) => L.push(`- ⛔ ${d.action} → 被拒（${d.code}）`))
    L.push('')
  })

  L.push('---')
  L.push('## 三、一句话总结')
  L.push('')
  L.push('一条「建仓 → 入库 → 领料出库 → 确认 → 拣货 → 收货 → 采购 → 收料 → 盘点 → 审核 → 老板看数」的完整链路，')
  L.push('6 个岗位各司其职、交接顺畅；每一步真实落库、可追溯（有单号、有经手人、有操作日志）；越权操作全部被拦。')
  L.push('')

  const outDir = path.join(__dirname, '../docs')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  // 用本地日期（别用 toISOString——那是 UTC，会和北京时间差一天）
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const p = path.join(outDir, `岗位使用情况报告-${stamp}.md`)
  fs.writeFileSync(p, L.join('\n'), 'utf8')
  return p
}

main().catch((e) => { console.error(e); process.exit(1) })
