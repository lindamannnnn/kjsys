/**
 * 厂长（director）角色验收
 * ============================================================
 * 需求（用户 2026-10-06）：
 *   厂长可以：发采购单、盘点、审核盘点、查看 2 个仓库的库存（能看到金额）
 *   厂长不可以：入库、拣货、收货、驳回/作废他人单据、看老板专属分析（趋势/物料排行/人员绩效）
 *
 * 需求追加（用户 2026-10-09）：
 *   厂长新增「成品仓出库」发起权 —— 从厂长面板发起，单子到成品仓管拣货，
 *   拣完通知厂长确认收货。**但只能开成品仓的单**，配件仓仍必须走仓管。
 *   → 所以 outbound.submit 不再一律 403，改为按仓库分档断言（见第 4 节）。
 *
 * 本脚本同时验证「放行」与「越权被拒」两侧，并带一组对照：
 *   仓管（dev_sk）审核盘点必须仍然被拒 —— 证明放行不是"把门整个打开"。
 *
 * 用法：node tests/role-agent/director-check.js
 * 依赖：后端已启动（127.0.0.1:3000）、ALLOW_DEV_LOGIN=true、dev_director 账号存在
 * 数据：测试产生的采购任务/盘点单/物料/出库单均带 MARK 标记，结束时全部清掉
 * ============================================================
 */
require('../../src/config/env')
const { loginDev, callRaw } = require('./lib')
const { query, queryOne, execute } = require('../../src/db/pool')

const MARK = 'ZZDIRTEST-' + Date.now().toString(36).toUpperCase()

let pass = 0, fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; failures.push(label + (detail ? ` :: ${detail}` : '')); console.log('  ❌', label, detail) }
}
const code = (res) => (res && typeof res.code === 'number' ? res.code : -1)

const created = { taskIds: [], checkIds: [], materialIds: [], outboundIds: [] }

async function cleanup() {
  console.log('\n== 清理测试数据 ==')
  for (const id of created.materialIds) {
    await execute('DELETE FROM materials WHERE id = ?', [id])
  }
  for (const id of created.checkIds) {
    await execute('DELETE FROM stock_check_items WHERE check_id = ?', [id])
    await execute('DELETE FROM stock_checks WHERE id = ?', [id])
  }
  for (const id of created.taskIds) {
    await execute('DELETE FROM purchase_task_items WHERE task_id = ?', [id])
    await execute('DELETE FROM purchase_tasks WHERE id = ?', [id])
  }
  // 审计留痕也一并清掉，避免污染回归报告
  // ⚠️ operation_logs.target_id 是 VARCHAR，直接传数字会触发 MySQL
  //   「Truncated incorrect DOUBLE value」（库里存着 'outbound.submit' 这类非数字值），
  //   所以这里必须传字符串做同类型比较。
  const allIds = [...created.taskIds, ...created.checkIds, ...created.materialIds].map(String)
  if (allIds.length) {
    await execute(
      `DELETE FROM operation_logs WHERE target_id IN (${allIds.map(() => '?').join(',')})`,
      allIds
    )
  }
  // 消息通知（盘点待审）按 ref 清
  for (const id of created.checkIds) {
    await execute("DELETE FROM messages WHERE ref_type = 'check' AND ref_id = ?", [id])
  }
  // 厂长「成品仓出库」放行验证产生的待确认单（pending 态没动库存，只需删明细+主单+消息）
  // ⚠️ 必须在删单据之前清消息，否则 ref_no 关联不上
  for (const id of created.outboundIds) {
    const row = await queryOne('SELECT order_no FROM outbound_orders WHERE id = ?', [id])
    if (row) await execute('DELETE FROM messages WHERE ref_no = ?', [row.order_no])
    await execute('DELETE FROM outbound_order_items WHERE order_id = ?', [id])
    await execute('DELETE FROM outbound_orders WHERE id = ?', [id])
    await execute('DELETE FROM operation_logs WHERE target_id = ?', [String(id)])
  }
  console.log(`  已清理：物料 ${created.materialIds.length} / 盘点 ${created.checkIds.length} / 采购任务 ${created.taskIds.length} / 出库单 ${created.outboundIds.length}`)
}

async function main() {
  console.log('==============================================')
  console.log('  厂长（director）角色验收')
  console.log('==============================================')

  const director = await loginDev('dev_director')
  const boss = await loginDev('dev_boss')
  const storekeeper = await loginDev('dev_sk')
  const out = await loginDev('dev_out')
  check('dev_director 登录成功', !!director)
  check('dev_boss / dev_sk / dev_out 登录成功（对照组）', !!boss && !!storekeeper && !!out)

  console.log('\n== 1. 身份与仓库范围 ==')
  const me = await callRaw('auth', 'getUserInfo', {}, director)
  const myRoles = (me.data && me.data.roles) || []
  check('身份含 director', myRoles.includes('director'), JSON.stringify(myRoles))
  const wl = await callRaw('warehouse', 'list', {}, director)
  const whIds = (wl.data.list || []).map((w) => Number(w._id)).sort()
  check('可见仓库 = 2 个（配件仓+成品仓）', whIds.length === 2 && whIds[0] === 1 && whIds[1] === 2, JSON.stringify(whIds))

  console.log('\n== 2. 库存与金额：应可见 ==')
  const ov = await callRaw('stats', 'overview', {}, director)
  check('stats.overview 放行', code(ov) === 0, JSON.stringify(ov.code))
  const ws = await callRaw('stats', 'warehouseSummary', {}, director)
  const wsList = (ws.data && ws.data.list) || []
  check('stats.warehouseSummary 放行', code(ws) === 0, JSON.stringify(ws.code))
  check('仓库总值含 2 个仓库', wsList.length === 2, JSON.stringify(wsList.map((w) => w.name)))
  check(
    '每个仓库都带金额字段（total_value 是数字）',
    wsList.length === 2 && wsList.every((w) => typeof w.total_value !== 'undefined' && !Number.isNaN(Number(w.total_value))),
    JSON.stringify(wsList.map((w) => w.total_value))
  )
  const sl = await callRaw('stats', 'stockList', { page: 1, pageSize: 10 }, director)
  check('stats.stockList 放行', code(sl) === 0, JSON.stringify(sl.code))
  check('库存行仓库都在 1/2', (sl.data.list || []).every((r) => [1, 2].includes(Number(r.warehouse_id))))
  check('stats.warning 放行', code(await callRaw('stats', 'warning', { page: 1, pageSize: 5 }, director)) === 0)
  check('stats.orderFlow 放行', code(await callRaw('stats', 'orderFlow', { page: 1, pageSize: 5 }, director)) === 0)
  check('stats.stockFlow 放行', code(await callRaw('stats', 'stockFlow', { page: 1, pageSize: 5 }, director)) === 0)

  console.log('\n== 3. 老板专属分析：应被拒（403）==')
  check('stats.trend 被拒', code(await callRaw('stats', 'trend', { days: 7 }, director)) === 403)
  check('stats.materialRank 被拒', code(await callRaw('stats', 'materialRank', {}, director)) === 403)
  check('stats.operatorStats 被拒', code(await callRaw('stats', 'operatorStats', {}, director)) === 403)

  console.log('\n== 4. 仓库写操作：出库只能开成品仓，拣货/收货仍归仓管 ==')
  // ⚠️ 2026-10-09 二改：厂长拿到「成品仓出库」发起权后，**不能再用 items:[] 空跑来测**：
  //    normalizeItems 排在权限判定之前，空明细会先返 400「出库项不能为空」，
  //    根本走不到成品仓守卫；那样「断言 403」和「断言放行」两边都测不准。
  //    必须带真实物料，才能分别验证「配件仓被守卫拦」「成品仓放行」。
  const dirStock1 = await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, director)
  const dirStock2 = await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 2 }, director)
  const mWh1 = (dirStock1.data.list || [])[0]
  const mWh2 = (dirStock2.data.list || [])[0]
  check('厂长能看到两个仓的库存（取测试物料前置条件）', !!mWh1 && !!mWh2,
    `wh1=${mWh1 && mWh1._id} wh2=${mWh2 && mWh2._id}`)

  // 配件仓 → 必须被「成品仓守卫」拒掉
  const crossWh = await callRaw('outbound', 'submit',
    { warehouse_id: 1, type: 'lingyong', items: [{ material_id: mWh1._id, quantity: 1 }] }, director)
  check('outbound.submit 配件仓被拒(403)', code(crossWh) === 403, JSON.stringify(crossWh))
  // 判据要认出是谁拒的：改动前 roleRules 里没有 director，任何仓都是 403，
  // 只断言 403 的话这条用例改不改都"绿"，等于没测到成品仓守卫
  check('拒绝来自「成品仓守卫」而非角色门（提示语点名成品仓）',
    /成品仓/.test(String(crossWh.message)), crossWh.message)

  // 不传 warehouse_id、直接塞配件仓物料，也必须被同一守卫拦下
  const crossWh2 = await callRaw('outbound', 'submit',
    { type: 'lingyong', items: [{ material_id: mWh1._id, quantity: 1 }] }, director)
  check('不传仓库、塞配件仓物料同样被拒(403)', code(crossWh2) === 403, JSON.stringify(crossWh2))

  // 成品仓 → 放行
  const okWh2 = await callRaw('outbound', 'submit',
    { warehouse_id: 2, type: 'sale', items: [{ material_id: mWh2._id, quantity: 1 }] }, director)
  check('outbound.submit 成品仓放行（厂长成品仓出库）', code(okWh2) === 0, JSON.stringify(okWh2))
  if (code(okWh2) === 0) created.outboundIds.push(okWh2.data._id)

  check('outbound.confirm 被拒（拣货前确认是仓管的活）', code(await callRaw('outbound', 'confirm', { id: 1 }, director)) === 403)
  check('outbound.pickDone 被拒（拣货是仓管的活）', code(await callRaw('outbound', 'pickDone', { id: 1 }, director)) === 403)
  check('outbound.reject 被拒', code(await callRaw('outbound', 'reject', { id: 1, reason: '越权测试' }, director)) === 403)

  // 收货：director 只对「自己发起的」放行，别人的单必须被拒
  //（roleRules 放行 director 是因为成品仓出库拣完要通知他确认，不是让他代收别人的货）
  const wh2Material = mWh2
  // 用 dev_sk（仓管，管辖 wh1+wh2）开一张成品仓的单，当成「别人的单」
  const otherOrder = await callRaw('outbound', 'submit',
    { warehouse_id: 2, type: 'lingyong', items: [{ material_id: wh2Material._id, quantity: 1 }] }, storekeeper)
  if (code(otherOrder) === 0) {
    created.outboundIds.push(otherOrder.data._id)
    check('outbound.receive 替别人收货被拒(403)',
      code(await callRaw('outbound', 'receive', { id: otherOrder.data._id }, director)) === 403)
  } else {
    check('⚠️ 无法构造「别人的单」用于收货越权验证', false, JSON.stringify(otherOrder))
  }

  check('inbound.submit 被拒', code(await callRaw('inbound', 'submit', { warehouse_id: 1, items: [] }, director)) === 403)
  // inbound.cancel 不在 roleRules 里（任何登录账号都能调），真正的门禁在函数内部：
  //   非本人提交 + 非 boss/admin → 403。厂长既不能提交入库单，也就永远不是「本人」。
  const realInbound = await queryOne("SELECT id FROM inbound_orders WHERE is_deleted = 0 ORDER BY id DESC LIMIT 1")
  if (realInbound) {
    check('inbound.cancel 对已存在的入库单被拒（403）', code(await callRaw('inbound', 'cancel', { id: realInbound.id, reason: '越权测试' }, director)) === 403)
  } else {
    check('（跳过）库里没有入库单，无法验证 inbound.cancel', true)
  }
  check('purchase.receiveItem 被拒', code(await callRaw('purchase', 'receiveItem', { task_id: 1, item_id: 1, arrived_qty: 1 }, director)) === 403)
  check('purchase.take 被拒（不是采购员）', code(await callRaw('purchase', 'take', { id: 1 }, director)) === 403)
  check('material.delete 被拒', code(await callRaw('material', 'delete', { id: 1 }, director)) === 403)

  console.log('\n== 5. 发采购单：应放行 ==')
  const m1 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, director)).data.list[0]
  check('取到配件仓一个物料', !!m1)
  const pc = await callRaw('purchase', 'create', {
    warehouse_id: 1,
    remark: MARK + ' 厂长发采购单',
    items: [{ material_id: m1._id, quantity: 2 }]
  }, director)
  check('purchase.create 放行', code(pc) === 0, JSON.stringify(pc.message))
  if (code(pc) === 0) created.taskIds.push(pc.data._id)
  // 同仓校验：把成品仓物料混进来应被业务层拦（不是 403，是 400）
  const m2 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 2 }, director)).data.list[0]
  const mix = await callRaw('purchase', 'create', {
    remark: MARK + ' 混仓',
    items: [{ material_id: m1._id, quantity: 1 }, { material_id: m2._id, quantity: 1 }]
  }, director)
  check('混仓采购被业务层拒绝（400）', code(mix) === 400, JSON.stringify(mix.code))

  console.log('\n== 6. 盘点：创建 → 录入 → 审核（含消息通知）==')
  // 只盘 1 个物料，且实盘=账面 → 差异 0，审核不会改动库存
  const ck = await callRaw('check', 'create', {
    warehouse_id: 1,
    type: 'sample',
    remark: MARK + ' 厂长盘点',
    scope: { material_ids: [m1._id] }
  }, director)
  check('check.create 放行', code(ck) === 0, JSON.stringify(ck.message))
  const checkId = code(ck) === 0 ? ck.data._id : 0
  if (checkId) created.checkIds.push(checkId)

  if (checkId) {
    const detail = await callRaw('check', 'detail', { id: checkId }, director)
    check('check.detail 放行', code(detail) === 0)
    const item = (detail.data.items || [])[0]
    const book = Number(item.book_stock || 0)
    const sb = await callRaw('check', 'submit', {
      id: checkId,
      items: [{ material_id: item.material_id, actual_stock: book }]
    }, director)
    check('check.submit 放行（实盘=账面，差异 0）', code(sb) === 0, JSON.stringify(sb.message))

    // 待审核消息应投递给 director（厂长也是审批人）
    const msg = await queryOne(
      "SELECT COUNT(*) c FROM messages WHERE ref_type='check' AND ref_id=? AND to_openid='dev_director'",
      [checkId]
    )
    check('盘点待审消息投递给厂长', Number(msg.c) > 0, JSON.stringify(msg))

    const rv = await callRaw('check', 'review', { id: checkId, approve: true, remark: MARK }, director)
    check('check.review 放行（厂长审核盘点）', code(rv) === 0, JSON.stringify(rv.message))
    const after = await queryOne('SELECT status FROM stock_checks WHERE id = ?', [checkId])
    check('审核后状态 = completed', after && after.status === 'completed', JSON.stringify(after))
  }

  console.log('\n== 7. 对照组：别人的权限没被放宽 ==')
  // 仓管能看盘点单（同仓）但不能审核
  if (checkId) {
    const ckList = await callRaw('check', 'list', { page: 1, pageSize: 50 }, storekeeper)
    const found = (ckList.data.list || []).some((c) => Number(c._id) === Number(checkId))
    check('仓管能在列表里看到厂长建的盘点单（同仓可见）', found, JSON.stringify(ckList.code))
  }
  const ck2 = await callRaw('check', 'create', {
    warehouse_id: 1, type: 'sample', remark: MARK + ' 仓管盘点', scope: { material_ids: [m1._id] }
  }, storekeeper)
  const ck2Id = code(ck2) === 0 ? ck2.data._id : 0
  if (ck2Id) {
    created.checkIds.push(ck2Id)
    const d2 = await callRaw('check', 'detail', { id: ck2Id }, storekeeper)
    const it2 = (d2.data.items || [])[0]
    await callRaw('check', 'submit', { id: ck2Id, items: [{ material_id: it2.material_id, actual_stock: Number(it2.book_stock || 0) }] }, storekeeper)
    const rv2 = await callRaw('check', 'review', { id: ck2Id, approve: true }, storekeeper)
    check('仓管审核盘点仍被拒（403）——放行不是把门全开', code(rv2) === 403, JSON.stringify(rv2.code))
    // 厂长能审这张「别人建的」盘点单 —— 这正是 assertCheckVisible 必须放行 director 的原因
    const dList = await callRaw('check', 'list', { page: 1, pageSize: 50 }, director)
    const inList = (dList.data.list || []).some((c) => Number(c._id) === Number(ck2Id))
    check('厂长列表里能出现在别人建的待审盘点单（否则审核入口找不到）', inList, JSON.stringify((dList.data.list || []).map((c) => c._id)))
    const dv = await callRaw('check', 'detail', { id: ck2Id }, director)
    check('厂长能点开别人建的盘点单（审核入口可达）', code(dv) === 0, JSON.stringify(dv.message))
    const rv3 = await callRaw('check', 'review', { id: ck2Id, approve: false, remark: MARK }, director)
    check('厂长能退回这张盘点单', code(rv3) === 0, JSON.stringify(rv3.message))
  }
  // 领料员（纯 out）不应看到任何金额口径的数据
  check('领料员 stats.warehouseSummary 被拒（不给看仓库总值/金额）', code(await callRaw('stats', 'warehouseSummary', {}, out)) === 403)
  const outStock = await callRaw('stats', 'stockList', { page: 1, pageSize: 1 }, out)
  const outRow = (outStock.data && outStock.data.list && outStock.data.list[0]) || null
  check('领料员 stats.stockList 的库存/成本字段已脱敏', !!outRow && outRow.current_stock === undefined && outRow.avg_cost === undefined, JSON.stringify(outRow && Object.keys(outRow)))
  const outRank = await callRaw('stats', 'materialRank', {}, out)
  check('领料员 stats.materialRank 被拒', code(outRank) === 403, JSON.stringify(outRank.code))

  await cleanup()

  console.log('\n----------------------------------------------')
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
  console.log('----------------------------------------------')
  if (fail) {
    console.log('失败清单：')
    failures.forEach((f) => console.log('  - ' + f))
  }
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => {
  console.error('[异常]', e && e.stack ? e.stack : e)
  try { await cleanup() } catch (_) { /* ignore */ }
  process.exit(1)
})
