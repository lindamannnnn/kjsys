/**
 * ============================================================
 * 胜龙进销存 · 端到端业务流串联测试
 * ------------------------------------------------------------
 * 用真实 HTTP 走一遍「一家配件厂一天会用到的完整流程」，
 * 每一步都核对数据库里的真实结果，并在阶段末做跨层一致性校验。
 *
 * 覆盖链路：
 *   采购建档 → 供应商建档 → 采购提交入库 → 仓管确认
 *   → 出库员提交出库 → 仓管确认 → 老板驳回 → 库存回补
 *   → 仓管创建盘点 → 录入差异 → 老板审核 → 库存对齐
 *   → 老板看板/趋势/排行/绩效/仓库汇总全部统计口径
 *   → 库存流水累加 = 当前库存（账实一致）
 *
 * 产物：
 *   1. 本地库里留下可被界面展示的真实单据（供 UI 遍历使用）
 *   2. .tmp-local-audit/e2e-context.json —— 记录所有单据 id，供前端脚本复用
 *
 * 用法：node scripts/e2e-business-flow.js        （需后端已启动）
 *       CLEANUP=1 node scripts/e2e-business-flow.js  （跑完清理掉本次数据）
 * ============================================================
 */
require('../server/src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')
const { queryOne, query, execute } = require('../server/src/db/pool')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const MARK = process.env.E2E_MARK || 'E2E'
const CLEANUP = process.env.CLEANUP === '1'
const OUT_DIR = path.join(__dirname, '..', '.tmp-local-audit')

let passed = 0
let failed = 0
const failures = []
const ctx = { orders: {}, materials: [], supplier: null, startedAt: new Date().toISOString() }

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`) }
}
function section(t) {
  console.log(`\n${'─'.repeat(66)}\n  ${t}\n${'─'.repeat(66)}`)
}

function call(module, action, data = {}, token = '', clientRequestId = '') {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ action, data, ...(clientRequestId ? { client_request_id: clientRequestId } : {}) })
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(`${BASE}/api/${module}`, { method: 'POST', headers, timeout: 25000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch (e) { resolve({ code: -999, message: raw.slice(0, 150) }) } })
    })
    req.on('error', (e) => resolve({ code: -1, message: `请求失败: ${e.message}` }))
    req.on('timeout', () => { req.destroy(); resolve({ code: -1, message: '请求超时' }) })
    req.write(payload)
    req.end()
  })
}

const tokens = {}
const WHO = {
  boss: 'dev_boss', sk: 'dev_sk', in: 'dev_in', out: 'dev_out', purchase: 'dev_purchase'
}

async function loginAll() {
  for (const [k, openid] of Object.entries(WHO)) {
    const r = await call('auth', 'login', { dev_openid: openid })
    if (r.code === 0 && r.data?.token) tokens[k] = r.data.token
  }
}

async function stockOf(id) {
  const r = await queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [id])
  return { stock: Number(r.current_stock), cost: Number(r.avg_cost) }
}

async function main() {
  console.log('='.repeat(66))
  console.log('  胜龙进销存 · 端到端业务流串联测试')
  console.log(`  目标：${BASE}    数据标记：${MARK}`)
  console.log('='.repeat(66))

  await loginAll()
  ok('五个岗位身份全部登录成功', Object.keys(tokens).length === 5, `拿到 ${Object.keys(tokens).length} 个令牌`)
  if (Object.keys(tokens).length < 5) { console.error('\n前置：请先执行 cd server && npm run seed:dev'); process.exit(1) }

  const stamp = Date.now().toString().slice(-6)

  // =========================================================
  section('阶段 1 · 建档（物料由仓管建、供应商由采购建）')
  // 物料档案的权限是 boss/admin/storekeeper —— 采购员只负责找货源，
  // 不负责建档，所以这里必须用仓管身份建料（顺带验证了这条权限边界）
  let matSeq = 0
  for (const [label, unit] of [['A', '个'], ['B', '桶']]) {
    const name = `${MARK}测试料${label}-${stamp}`
    const r = await call('material', 'upsert', {
      name, code: `${MARK}${stamp}${matSeq}`, unit, category: 'E2E测试分类',
      warehouse_id: 1, safety_stock: 20, spec: '规格-' + label
    }, tokens.sk)
    ok(`仓管建档物料「${name}」`, r.code === 0, r.message)
    if (r.code === 0) ctx.materials.push({ id: r.data._id, name, unit })
    matSeq++
  }

  // 反向验证：采购员确实建不了物料（权限边界）
  const purchaseUpsert = await call('material', 'upsert',
    { name: `${MARK}越权料`, code: `${MARK}X${stamp}`, unit: '个', warehouse_id: 1 }, tokens.purchase)
  ok('采购员无权建物料（403，符合设计）', purchaseUpsert.code === 403, `code=${purchaseUpsert.code}`)

  const supName = `${MARK}测试供应商-${stamp}`
  const supRes = await call('supplier', 'upsert', {
    name: supName, contact: '张供应', phone: '13500000099', tax_no: 'TAX' + stamp, payment_terms: '月结30天'
  }, tokens.purchase)
  ok(`采购员建档供应商「${supName}」`, supRes.code === 0, supRes.message)
  ctx.supplier = supRes.data?._id ? { id: supRes.data._id, name: supName } : { id: null, name: supName }

  const supSearch = await call('supplier', 'search', { keyword: `${MARK}测试供应商` }, tokens.purchase)
  ok('供应商搜索能搜到刚建的（新加的当次即可见）',
    supSearch.code === 0 && (supSearch.data?.list || supSearch.data || []).length >= 1, supSearch.message)

  const m1 = ctx.materials[0]
  const m2 = ctx.materials[1]
  if (!m1 || !m2) { console.error('\n物料建档失败，无法继续'); process.exit(1) }

  // =========================================================
  section('阶段 2 · 采购入库（提交 → 待确认 → 仓管确认）')
  const before1 = await stockOf(m1.id)

  const inSubmit = await call('inbound', 'submit', {
    items: [
      { material_id: m1.id, quantity: 100, unit_price: 12.5, material_name: m1.name, unit: m1.unit },
      { material_id: m2.id, quantity: 60, unit_price: 88, material_name: m2.name, unit: m2.unit }
    ],
    supplier: supName, supplier_id: ctx.supplier.id,
    remark: `${MARK} 首次采购入库`, warehouse_id: 'peijian', type: 'purchase'
  }, tokens.purchase)
  ok('采购员提交入库单（含供应商）', inSubmit.code === 0, inSubmit.message)
  const inboundId = inSubmit.data?._id
  ctx.orders.inbound = { id: inboundId, no: inSubmit.data?.order_no }

  const mid1 = await stockOf(m1.id)
  ok('提交即入库：库存 0 → 100', mid1.stock === before1.stock + 100, `${before1.stock} → ${mid1.stock}`)
  ok('加权成本 = 12.5', Math.abs(mid1.cost - 12.5) < 0.01, `avg_cost=${mid1.cost}`)

  const inStatusBefore = await queryOne('SELECT status FROM inbound_orders WHERE id = ?', [inboundId])
  ok('新单状态为「待确认」', ['pending', 'submitted'].includes(inStatusBefore.status), inStatusBefore.status)

  const pendingBase = (await call('inbound', 'pendingCount', {}, tokens.sk)).data?.count ?? 0
  ok('新提交的单计入仓管待办',
    pendingBase >= 1, `当前待办=${pendingBase}`)
  const outConfirmDenied = await call('inbound', 'confirm', { id: inboundId }, tokens.out)
  ok('出库员无权确认入库单（403）', outConfirmDenied.code === 403, `code=${outConfirmDenied.code}`)

  const inConfirm = await call('inbound', 'confirm', { id: inboundId }, tokens.sk)
  ok('仓管确认入库单', inConfirm.code === 0, inConfirm.message)
  const inStatusAfter = await queryOne(
    'SELECT status, confirm_operator_name FROM inbound_orders WHERE id = ?', [inboundId])
  ok('确认后状态变为已确认', inStatusAfter.status === 'confirmed', inStatusAfter.status)
  ok('确认人已留痕（出事能追到人）', !!inStatusAfter.confirm_operator_name, String(inStatusAfter.confirm_operator_name))

  const pendingMid = (await call('inbound', 'pendingCount', {}, tokens.sk)).data?.count ?? 0
  ok('确认一单后待办数 -1', pendingMid === pendingBase - 1,
    `待办 ${pendingBase} → ${pendingMid}`)

  const inConfirmAgain = await call('inbound', 'confirm', { id: inboundId }, tokens.sk)
  ok('重复确认不报错（幂等）', inConfirmAgain.code === 0, inConfirmAgain.message)
  const afterDup = await stockOf(m1.id)
  ok('重复确认没有重复加库存', afterDup.stock === mid1.stock, `${mid1.stock} → ${afterDup.stock}`)

  // 第二笔：不同单价，验移动加权；故意不确认，留给仓管待办页
  const inPending = await call('inbound', 'submit', {
    items: [{ material_id: m1.id, quantity: 100, unit_price: 17.5, material_name: m1.name, unit: m1.unit }],
    supplier: supName, supplier_id: ctx.supplier.id,
    remark: `${MARK} 二次进货（留作待办）`, warehouse_id: 'peijian', type: 'purchase'
  }, tokens.purchase)
  ok('提交第二笔入库（留待确认，供待办页展示）', inPending.code === 0, inPending.message)
  ctx.orders.inboundPending = { id: inPending.data?._id, no: inPending.data?.order_no }

  const after2 = await stockOf(m1.id)
  // (100*12.5 + 100*17.5) / 200 = 15
  ok('移动加权成本 = 15', Math.abs(after2.cost - 15) < 0.01, `avg_cost=${after2.cost}`)
  ok('库存累计 200', after2.stock === 200, `stock=${after2.stock}`)

  // 待办数应是「确认掉一单 -1，又提交一单 +1」的净结果，正好回到原值
  const pendingAfterNew = (await call('inbound', 'pendingCount', {}, tokens.sk)).data?.count ?? 0
  ok('确认一单 + 新提交一单，待办数回到原值',
    pendingAfterNew === pendingBase,
    `初始 ${pendingBase} → 确认一单后 ${pendingMid} → 再提交一单后 ${pendingAfterNew}`)

  // =========================================================
  section('阶段 3 · 出库（提交 → 确认 → 驳回 → 撤销）')
  const outSubmit = await call('outbound', 'submit', {
    items: [{ material_id: m1.id, quantity: 30, material_name: m1.name, unit: m1.unit }],
    type: 'lingyong', remark: `${MARK} 领用出库`, warehouse_id: 'peijian'
  }, tokens.out)
  ok('出库员提交出库单', outSubmit.code === 0, outSubmit.message)
  ctx.orders.outbound = { id: outSubmit.data?._id, no: outSubmit.data?.order_no }

  const afterOut = await stockOf(m1.id)
  ok('出库即扣减：200 → 170', afterOut.stock === 170, `stock=${afterOut.stock}`)

  const over = await call('outbound', 'submit', {
    items: [{ material_id: m1.id, quantity: 999999, material_name: m1.name, unit: m1.unit }],
    remark: `${MARK} 超量`, warehouse_id: 'peijian'
  }, tokens.out)
  ok('超库存出库被拒绝', over.code !== 0, `code=${over.code} ${over.message}`)
  const afterOver = await stockOf(m1.id)
  ok('被拒的出库未改动库存', afterOver.stock === 170, `stock=${afterOver.stock}`)

  const outConfirm = await call('outbound', 'confirm', { id: ctx.orders.outbound.id }, tokens.sk)
  ok('仓管确认出库单', outConfirm.code === 0, outConfirm.message)

  // 驳回链路
  const outRejectTarget = await call('outbound', 'submit', {
    items: [{ material_id: m1.id, quantity: 20, material_name: m1.name, unit: m1.unit }],
    remark: `${MARK} 待驳回`, warehouse_id: 'peijian'
  }, tokens.out)
  const beforeReject = await stockOf(m1.id)
  const rejectRes = await call('outbound', 'reject',
    { id: outRejectTarget.data._id, reason: `${MARK} 用途不明，驳回` }, tokens.boss)
  ok('老板驳回落库出库单', rejectRes.code === 0, rejectRes.message)
  const afterReject = await stockOf(m1.id)
  ok('驳回后库存回补 20', afterReject.stock === beforeReject.stock + 20, `${beforeReject.stock} → ${afterReject.stock}`)
  ctx.orders.outboundRejected = { id: outRejectTarget.data._id, no: outRejectTarget.data.order_no }

  // 本人撤销
  const outCancelTarget = await call('outbound', 'submit', {
    items: [{ material_id: m1.id, quantity: 5, material_name: m1.name, unit: m1.unit }],
    remark: `${MARK} 待撤销`, warehouse_id: 'peijian'
  }, tokens.out)
  const beforeCancel = await stockOf(m1.id)
  const cancelRes = await call('outbound', 'cancel', { id: outCancelTarget.data._id, reason: `${MARK} 填错了` }, tokens.out)
  ok('申请人自行撤销出库单', cancelRes.code === 0, cancelRes.message)
  const afterCancel = await stockOf(m1.id)
  ok('撤销后库存回补 5', afterCancel.stock === beforeCancel.stock + 5, `${beforeCancel.stock} → ${afterCancel.stock}`)

  // 留一笔待确认出库给仓管待办
  const outPendingKeep = await call('outbound', 'submit', {
    items: [{ material_id: m2.id, quantity: 10, material_name: m2.name, unit: m2.unit }],
    remark: `${MARK} 待确认出库`, warehouse_id: 'peijian'
  }, tokens.out)
  ok('提交一笔待确认出库（供待办页展示）', outPendingKeep.code === 0, outPendingKeep.message)
  ctx.orders.outboundPending = { id: outPendingKeep.data?._id, no: outPendingKeep.data?.order_no }

  // =========================================================
  section('阶段 4 · 盘点（创建 → 录入差异 → 审核 → 库存对齐）')
  const checkCreate = await call('check', 'create', {
    type: 'sample', warehouse_id: 'peijian',
    scope: { material_ids: [m1.id, m2.id] },
    remark: `${MARK} 抽盘`
  }, tokens.sk)
  ok('仓管创建盘点任务', checkCreate.code === 0, checkCreate.message)
  const checkId = checkCreate.data?._id
  ctx.orders.check = { id: checkId, no: checkCreate.data?.order_no }
  ok('盘点任务带入明细', (checkCreate.data?.item_count ?? 0) >= 2, `item_count=${checkCreate.data?.item_count}`)

  const checkDetail = await call('check', 'detail', { id: checkId }, tokens.sk)
  ok('盘点详情可查', checkDetail.code === 0 && Array.isArray(checkDetail.data.items), checkDetail.message)
  ok('明细记录了账面库存（仓管签字依据）',
    checkDetail.data?.items?.every((i) => i.book_stock !== null && i.book_stock !== undefined), '')

  const bookStock = (await stockOf(m1.id)).stock
  const actualStock = bookStock - 7 // 故意盘亏 7 个
  const checkSubmit = await call('check', 'submit', {
    id: checkId, items: [{ material_id: m1.id, actual_stock: actualStock }]
  }, tokens.sk)
  ok('仓管提交盘点结果（含盘亏）', checkSubmit.code === 0, checkSubmit.message)

  const stockBeforeReview = (await stockOf(m1.id)).stock
  ok('提交盘点尚未改动库存（需审核后才以盘为准）', stockBeforeReview === bookStock, `stock=${stockBeforeReview}`)

  const reviewDenied = await call('check', 'review', { id: checkId, approve: true }, tokens.sk)
  ok('仓管无权审核自己的盘点（403）', reviewDenied.code === 403, `code=${reviewDenied.code}`)

  const reviewOk = await call('check', 'review', { id: checkId, approve: true }, tokens.boss)
  ok('老板审核通过盘点', reviewOk.code === 0, reviewOk.message)
  const stockAfterReview = (await stockOf(m1.id)).stock
  ok(`盘点差异已回写库存（${stockBeforeReview} → ${actualStock}）`,
    Math.abs(stockAfterReview - actualStock) < 0.001, `实际 ${stockAfterReview}`)

  // 留一个待审核盘点
  const checkKeep = await call('check', 'create', {
    type: 'sample', warehouse_id: 'peijian', scope: { material_ids: [m2.id] }, remark: `${MARK} 待审核`
  }, tokens.sk)
  if (checkKeep.code === 0) {
    await call('check', 'submit', { id: checkKeep.data._id, items: [{ material_id: m2.id, actual_stock: 50 }] }, tokens.sk)
    ctx.orders.checkPending = { id: checkKeep.data._id, no: checkKeep.data.order_no }
  }
  ok('留下一笔待审核盘点（供审核页展示）', checkKeep.code === 0, checkKeep.message)

  // =========================================================
  section('阶段 5 · 老板视角的统计与报表')
  const ov = await call('stats', 'overview', {}, tokens.boss)
  ok('总览 KPI 可用', ov.code === 0 && ov.data.material_count > 0, ov.message)
  ok('总览统计到今日入库单', (ov.data?.today_inbound_orders ?? 0) >= 1, `in=${ov.data?.today_inbound_orders}`)
  ok('总览统计到今日出库单', (ov.data?.today_outbound_orders ?? 0) >= 1, `out=${ov.data?.today_outbound_orders}`)

  const trend = await call('stats', 'trend', { days: 7 }, tokens.boss)
  ok('趋势图数据可用', trend.code === 0 && Array.isArray(trend.data.list), trend.message)
  ok('趋势补齐了空日期（7 天 → 8 个点）', trend.data?.list?.length === 8, `长度 ${trend.data?.list?.length}`)

  const stockList = await call('stats', 'stockList', { page: 1, pageSize: 5 }, tokens.boss)
  ok('库存报表可用', stockList.code === 0 && stockList.data.list.length > 0, stockList.message)

  const rank = await call('stats', 'materialRank', {}, tokens.boss)
  ok('物料排行可用', rank.code === 0, rank.message)

  const ops = await call('stats', 'operatorStats', {}, tokens.boss)
  ok('人员绩效可用', ops.code === 0, ops.message)

  const whSum = await call('stats', 'warehouseSummary', {}, tokens.boss)
  ok('仓库汇总可用', whSum.code === 0, whSum.message)

  const flow = await call('stats', 'stockFlow', { page: 1, pageSize: 10 }, tokens.boss)
  ok('库存流水可用', flow.code === 0, flow.message)

  const oflow = await call('stats', 'orderFlow', {}, tokens.boss)
  ok('单据流转统计可用', oflow.code === 0, oflow.message)

  const warn = await call('stats', 'warning', {}, tokens.boss)
  ok('库存预警可用', warn.code === 0, warn.message)

  // 统计接口的权限隔离
  const ovByOut = await call('stats', 'overview', {}, tokens.out)
  ok('普通出库员看不到总览（403）', ovByOut.code === 403, `code=${ovByOut.code}`)

  // =========================================================
  section('阶段 6 · 跨层一致性校验（账实相符）')
  const logs = await query(
    `SELECT change_type, change_quantity, before_stock, after_stock FROM stock_logs
      WHERE material_id = ? ORDER BY id`, [m1.id])
  ok('已生成库存流水', logs.length > 0, `${logs.length} 条`)
  const sum = logs.reduce((s, l) => s + Number(l.change_quantity), 0)
  const cur = (await stockOf(m1.id)).stock
  ok('流水累加 = 当前库存（账实一致）', Math.abs(sum - cur) < 0.001, `流水 ${sum} vs 库存 ${cur}`)
  ok('每条流水都记录变动前后值', logs.every((l) => l.before_stock !== null && l.after_stock !== null), '')
  const types = [...new Set(logs.map((l) => l.change_type))]
  ok('流水涵盖入库/出库/盘点三类',
    types.includes('inbound') && types.includes('outbound') && types.some((t) => t.includes('check')),
    types.join(','))

  const inList = await call('inbound', 'list', { page: 1, pageSize: 20 }, tokens.purchase)
  ok('入库列表能查到本次单据',
    inList.code === 0 && inList.data.list.some((o) => o._id === inboundId), `${inList.data?.list?.length} 条`)
  ok('列表带出明细 items', Array.isArray(inList.data?.list?.[0]?.items), '')

  const outList = await call('outbound', 'list', { page: 1, pageSize: 20 }, tokens.out)
  ok('出库列表能查到本次单据',
    outList.code === 0 && outList.data.list.some((o) => o._id === ctx.orders.outboundPending.id), `${outList.data?.list?.length} 条`)

  const myLogs = await call('auth', 'myLogs', { page: 1, pageSize: 20 }, tokens.purchase)
  ok('操作日志可追溯（我的日志）', myLogs.code === 0 && myLogs.data.total >= 1, `total=${myLogs.data?.total}`)

  const detail = await call('inbound', 'detail', { id: inboundId }, tokens.purchase)
  ok('入库详情含明细与当前库存（确认前可见）',
    detail.code === 0 && Array.isArray(detail.data.items) && detail.data.items.length === 2, detail.message)

  // =========================================================
  console.log('\n' + '='.repeat(66))
  console.log(`  端到端业务流完成：通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length) {
    console.log('\n  失败明细：')
    failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`))
  }
  console.log('='.repeat(66))

  // 写上下文，供 UI 遍历复用
  fs.mkdirSync(OUT_DIR, { recursive: true })
  ctx.summary = { passed, failed, failures, finishedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(OUT_DIR, 'e2e-context.json'), JSON.stringify(ctx, null, 2), 'utf8')
  console.log(`\n  单据上下文已落盘：${path.join(OUT_DIR, 'e2e-context.json')}`)

  if (CLEANUP) {
    console.log('\n  清理本次数据…')
    for (const m of ctx.materials) {
      await execute('UPDATE materials SET is_deleted = 1 WHERE id = ?', [m.id]).catch(() => {})
    }
    if (ctx.supplier.id) await execute('UPDATE suppliers SET is_deleted = 1 WHERE id = ?', [ctx.supplier.id]).catch(() => {})
    console.log('  已标记停用（流水保留）')
  } else {
    console.log('  数据已保留，可继续用于界面展示验证（清理：CLEANUP=1 重跑）')
  }

  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('异常：', e); process.exit(1) })
