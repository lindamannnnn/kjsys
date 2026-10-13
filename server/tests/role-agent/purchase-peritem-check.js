/**
 * 采购「到货即入库」验证（2026-10-09 改版口径）
 *
 * 老板拍板：点「到货」当场把库存写进去，不再需要单独点一次「入库」。
 *   ① 分次到货按**差额**累加（第一次 3、第二次补到 5 → 只再加 2）
 *   ② 报多了改小 → 自动把对应的入库单冲回，库存同步减
 *   ③ 重复提交同一数量 → 幂等，库存不动
 *   ④ 「完成收货」**不再动库存**（库存已经在到货时加过）
 *   ⑤ 退回采购员 → 已入账的库存要冲回来（否则会出幽灵库存）
 */
require('../../src/config/env')
const { loginDev, callRaw } = require('./lib')
const { query, queryOne } = require('../../src/db/pool')
// 收尾清理：本脚本会建测试物料/单据/采购任务/站内消息，跑完必须自己清掉（--no-cleanup 跳过）
const { autoCleanup } = require('./_cleanup')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

const stockOf = async (id) => Number((await queryOne('SELECT current_stock FROM materials WHERE id = ?', [id])).current_stock)

async function main() {
  const sk = await loginDev('dev_sk_parts')
  const pc = await loginDev('dev_purchase')
  const mark = '[V5-RECV]'

  // 物料（残留复用）
  const findMat = async (name) => {
    const r = await callRaw('material', 'list', { warehouse_id: 1, keyword: name, page: 1, pageSize: 5 }, sk)
    return ((r.data && r.data.list) || []).find((m) => m.name === name)
  }
  let mA = await callRaw('material', 'upsert', { name: `${mark}料A`, spec: 'V5-A', category: '测试类', unit: '个', warehouse_id: 1, remark: mark }, sk)
  if (mA.code === 409) mA = { code: 0, data: { _id: (await findMat(`${mark}料A`))._id } }
  let mB = await callRaw('material', 'upsert', { name: `${mark}料B`, spec: 'V5-B', category: '测试类', unit: '个', warehouse_id: 1, remark: mark }, sk)
  if (mB.code === 409) mB = { code: 0, data: { _id: (await findMat(`${mark}料B`))._id } }
  const A = mA.data._id, B = mB.data._id
  // 复用物料可能有余量，先读基数；再各入 10 件 @10
  const baseA = await stockOf(A)
  const baseB = await stockOf(B)
  for (const mid of [A, B]) {
    const ib = await callRaw('inbound', 'submit', { warehouse_id: 1, supplier: 'V5供应商', remark: mark, items: [{ material_id: mid, quantity: 10, unit_price: 10 }] }, sk)
    if (ib.code !== 0) { console.log('入库失败:', JSON.stringify(ib)); process.exit(1) }
    await callRaw('inbound', 'confirm', { id: ib.data._id }, sk)
  }

  console.log('== ① 到货即入库：分次累加 + 改小冲回 ==')
  const c = await callRaw('purchase', 'create', {
    warehouse_id: 1, assignee_openid: 'dev_purchase', remark: mark,
    items: [{ material_id: A, quantity: 5 }, { material_id: B, quantity: 4 }]
  }, sk)
  const tid = c.data._id
  await callRaw('purchase', 'take', { id: tid }, pc)
  await callRaw('purchase', 'entry', { id: tid, items: [
    { material_id: A, unit_price: 12, purchase_channel: '淘宝', external_no: 'TB-V5-1' },
    { material_id: B, unit_price: 8, purchase_channel: '线下' }
  ] }, pc)
  const d0 = await callRaw('purchase', 'detail', { id: tid }, sk)
  const itemA = d0.data.items.find((i) => i.material_id === A)
  const itemB = d0.data.items.find((i) => i.material_id === B)

  // A 第一次到 3/5 —— 关键：点「到货」就该加库存
  let r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemA._id, action: 'receive', received_qty: 3 }, sk)
  check('A 到货 3/5 登记为 partial', r.code === 0 && r.data.receive_status === 'partial', JSON.stringify(r))
  check('★ 到货当场加库存 +3（不用再点入库）', await stockOf(A) === baseA + 10 + 3, `${await stockOf(A)} vs ${baseA + 13}`)
  check('已入账数量记为 3', Number(r.data.stocked_qty) === 3, JSON.stringify(r.data))

  // 未完成不能办结
  r = await callRaw('purchase', 'receive', { id: tid }, sk)
  check('还有项没完成不能办结', r.code === 400 && /没有完成/.test(r.message), r.message)

  // 超量拦截
  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemA._id, action: 'receive', received_qty: 6 }, sk)
  check('实到超采购数被拒', r.code === 400 && /超过/.test(r.message), r.message)

  // 分次补到 5 —— 只加差额 2
  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemA._id, action: 'receive', received_qty: 5 }, sk)
  check('A 补到 5/5 到齐', r.code === 0 && r.data.receive_status === 'received', JSON.stringify(r))
  check('★ 分次到货只加差额 +2（不是再加 5）', await stockOf(A) === baseA + 10 + 5, `${await stockOf(A)} vs ${baseA + 15}`)

  // 重复提交同一数量 → 幂等
  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemA._id, action: 'receive', received_qty: 5 }, sk)
  check('重复提交同一数量：不产生新入库单', r.code === 0 && (r.data.inbound_orders || []).length === 0, JSON.stringify(r.data))
  check('幂等后库存不变', await stockOf(A) === baseA + 15, String(await stockOf(A)))

  // 改小 → 自动冲回
  const ordersBefore = await query(
    `SELECT o.id, o.status, oi.quantity FROM inbound_orders o
       JOIN inbound_order_items oi ON oi.order_id = o.id
      WHERE o.source_item_id = ? ORDER BY o.id`, [itemA._id])
  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemA._id, action: 'receive', received_qty: 4 }, sk)
  check('A 到货数改小到 4 成功', r.code === 0, r.message)
  check('★ 改小后库存自动冲回 -1', await stockOf(A) === baseA + 10 + 4, `${await stockOf(A)} vs ${baseA + 14}`)
  const ordersAfter = await query('SELECT status FROM inbound_orders WHERE source_item_id = ? ORDER BY id', [itemA._id])
  check('冲回留下了作废痕迹（不是静默改数）',
    ordersAfter.some((o) => o.status === 'cancelled'), JSON.stringify(ordersAfter.map((o) => o.status)))

  // 入库单都是这项的，不会被别的项串到
  check('入库单来源指向该明细（source_item_id）', ordersBefore.length >= 1, JSON.stringify(ordersBefore.map((o) => o.id)))

  console.log('== ② 退货项：已到部分已经入账，办结不再加库存 ==')
  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemB._id, action: 'receive', received_qty: 1 }, sk)
  check('B 到货 1/4 登记为 partial', r.code === 0 && r.data.receive_status === 'partial', JSON.stringify(r))
  check('B 到货当场加库存 +1', await stockOf(B) === baseB + 10 + 1, `${await stockOf(B)} vs ${baseB + 11}`)

  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemB._id, action: 'return', return_reason: '破损' }, sk)
  check('B 剩余退货（实到 1 保留）', r.code === 0 && Number(r.data.received_qty) === 1, JSON.stringify(r))
  check('退货不动已入账的库存', await stockOf(B) === baseB + 11, String(await stockOf(B)))

  // A 在 ① 里被改小到 4，办结前得先到齐或退货 —— 这里补回 5（顺带验证「改小后还能再改大」）
  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemA._id, action: 'receive', received_qty: 5 }, sk)
  check('A 补回到齐 5/5（改小之后还能改大）', r.code === 0 && r.data.receive_status === 'received', JSON.stringify(r))
  check('改大只补差额 +1', await stockOf(A) === baseA + 10 + 5, `${await stockOf(A)} vs ${baseA + 15}`)

  // ★ 核心：办结不再加库存
  const stockA_before = await stockOf(A)
  const stockB_before = await stockOf(B)
  r = await callRaw('purchase', 'receive', { id: tid }, sk)
  check('完成收货成功', r.code === 0, r.message)
  check('★ 完成收货不再加库存（A 不变）', await stockOf(A) === stockA_before, `${await stockOf(A)} vs ${stockA_before}`)
  check('★ 完成收货不再加库存（B 不变）', await stockOf(B) === stockB_before, `${await stockOf(B)} vs ${stockB_before}`)

  const dFinal = await callRaw('purchase', 'detail', { id: tid }, sk)
  check('办结后任务状态 received', dFinal.data.status === 'received', dFinal.data.status)
  check('任务详情返回入库单列表', Array.isArray(dFinal.data.inbound_orders) && dFinal.data.inbound_orders.length >= 1,
    JSON.stringify((dFinal.data.inbound_orders || []).map((o) => o.order_no)))
  check('累计已入库 = 6（A 的 5 + B 的 1）',
    dFinal.data.items.reduce((s, i) => s + Number(i.stocked_qty), 0) === 6,
    JSON.stringify(dFinal.data.items.map((i) => i.stocked_qty)))

  // 办结后锁死
  r = await callRaw('purchase', 'receiveItem', { id: tid, item_id: itemA._id, action: 'receive', received_qty: 5 }, sk)
  check('办结后不能再改到货数量', r.code === 400, r.message)

  console.log('== ③ 退回采购员：已入账的库存要冲回来 ==')
  const c3 = await callRaw('purchase', 'create', { warehouse_id: 1, assignee_openid: 'dev_purchase', remark: mark, items: [{ material_id: A, quantity: 3 }] }, sk)
  const tid3 = c3.data._id
  await callRaw('purchase', 'take', { id: tid3 }, pc)
  await callRaw('purchase', 'entry', { id: tid3, items: [{ material_id: A, unit_price: 12, purchase_channel: '淘宝' }] }, pc)
  const d3 = await callRaw('purchase', 'detail', { id: tid3 }, sk)
  const stockA_before3 = await stockOf(A)
  r = await callRaw('purchase', 'receiveItem', { id: tid3, item_id: d3.data.items[0]._id, action: 'receive', received_qty: 2 }, sk)
  check('第三单 A 到货 2 → 加库存', r.code === 0 && await stockOf(A) === stockA_before3 + 2, `${await stockOf(A)} vs ${stockA_before3 + 2}`)

  r = await callRaw('purchase', 'rejectBack', { id: tid3, reason: '单价填错，请重填' }, sk)
  check('退回采购员成功', r.code === 0, r.message)
  check('★ 退回后库存被冲回（不留幽灵库存）', await stockOf(A) === stockA_before3, `${await stockOf(A)} vs ${stockA_before3}`)
  const d3b = await callRaw('purchase', 'detail', { id: tid3 }, sk)
  check('退回后明细重置为未登记',
    d3b.data.items.every((i) => i.receive_status === 'pending' && Number(i.stocked_qty) === 0),
    JSON.stringify(d3b.data.items.map((i) => [i.receive_status, i.stocked_qty])))

  console.log('== ④ 全部退货（零到货）==')
  const c2 = await callRaw('purchase', 'create', { warehouse_id: 1, assignee_openid: 'dev_purchase', remark: mark, items: [{ material_id: B, quantity: 2 }] }, sk)
  const tid2 = c2.data._id
  await callRaw('purchase', 'take', { id: tid2 }, pc)
  await callRaw('purchase', 'entry', { id: tid2, items: [{ material_id: B, unit_price: 8, purchase_channel: '线下' }] }, pc)
  const d2 = await callRaw('purchase', 'detail', { id: tid2 }, sk)
  const stockB_before2 = await stockOf(B)
  r = await callRaw('purchase', 'receiveItem', { id: tid2, item_id: d2.data.items[0]._id, action: 'return', return_reason: '全部不合格' }, sk)
  check('零到货整项退货', r.code === 0, r.message)
  check('全退不产生库存变动', await stockOf(B) === stockB_before2, String(await stockOf(B)))
  r = await callRaw('purchase', 'receive', { id: tid2 }, sk)
  check('全退办结成功且累计入库为 0', r.code === 0 && Number(r.data.stocked_qty) === 0, JSON.stringify(r.data))
  const ibCnt = await queryOne(
    `SELECT COUNT(*) c FROM inbound_orders o
       JOIN inbound_order_items oi ON oi.order_id = o.id
      WHERE o.source_item_id = ?`, [d2.data.items[0]._id])
  check('全退没有生成入库单', Number(ibCnt.c) === 0, JSON.stringify(ibCnt))

  console.log('== ⑤ 兼容层：老的单项入库接口不再重复加库存 ==')
  const c5 = await callRaw('purchase', 'create', { warehouse_id: 1, assignee_openid: 'dev_purchase', remark: mark, items: [{ material_id: A, quantity: 2 }] }, sk)
  const tid5 = c5.data._id
  await callRaw('purchase', 'take', { id: tid5 }, pc)
  await callRaw('purchase', 'entry', { id: tid5, items: [{ material_id: A, unit_price: 12, purchase_channel: '淘宝' }] }, pc)
  const d5 = await callRaw('purchase', 'detail', { id: tid5 }, sk)
  await callRaw('purchase', 'receiveItem', { id: tid5, item_id: d5.data.items[0]._id, action: 'receive', received_qty: 2 }, sk)
  const stockA_before5 = await stockOf(A)
  r = await callRaw('purchase', 'stockItem', { id: tid5, item_id: d5.data.items[0]._id }, sk)
  check('再点老的「入库」是幂等的', r.code === 0 && r.data.duplicated === true, JSON.stringify(r))
  check('幂等后库存不变', await stockOf(A) === stockA_before5, String(await stockOf(A)))

  console.log(`\n结果：${pass} 过 / ${fail} 挂`)
  autoCleanup()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); autoCleanup(); process.exit(1) })
