/**
 * 分仓隔离验证：配件仓管(dev_sk_parts)只能看到/操作配件仓，成品仓管(dev_sk_goods)只能成品仓
 * 覆盖：仓库列表、库存、看板、出入库单、采购任务、盘点单、跨仓写拦截、消息按仓投递
 */
require('../../src/config/env')
const { loginDev, callRaw } = require('./lib')
const { query, execute } = require('../../src/db/pool')
// 收尾清理：本脚本会建测试物料/单据/站内消息，跑完必须自己清掉（--no-cleanup 跳过）
const { autoCleanup } = require('./_cleanup')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

async function main() {
  const parts = await loginDev('dev_sk_parts')
  const goods = await loginDev('dev_sk_goods')
  const out = await loginDev('dev_out')

  console.log('== 1. 仓库列表 ==')
  const wlP = await callRaw('warehouse', 'list', {}, parts)
  const wlG = await callRaw('warehouse', 'list', {}, goods)
  check('配件仓管只见配件仓', wlP.data.list.length === 1 && wlP.data.list[0]._id === 1, JSON.stringify(wlP.data.list.map(w=>w._id)))
  check('成品仓管只见成品仓', wlG.data.list.length === 1 && wlG.data.list[0]._id === 2, JSON.stringify(wlG.data.list.map(w=>w._id)))

  console.log('== 2. 库存列表 ==')
  const stP = await callRaw('stats', 'stockList', { page: 1, pageSize: 5 }, parts)
  const stG = await callRaw('stats', 'stockList', { page: 1, pageSize: 5 }, goods)
  check('配件仓管库存全在 wh1', stP.data.list.every(r => r.warehouse_id === 1) && stP.data.list.length > 0)
  check('成品仓管库存全在 wh2', stG.data.list.every(r => r.warehouse_id === 2) && stG.data.list.length > 0)
  check('配件仓管显式查 wh2 被查空', (await callRaw('stats', 'stockList', { page: 1, pageSize: 5, warehouse_id: 2 }, parts)).data.list.length === 0)

  console.log('== 3. 看板 ==')
  const ovP = await callRaw('stats', 'overview', {}, parts)
  const ovG = await callRaw('stats', 'overview', {}, goods)
  check('配件仓管看板物料数=配件仓物料数', ovP.data.material_count > 1000, JSON.stringify(ovP.data.material_count))
  check('成品仓管看板物料数=成品仓物料数', ovG.data.material_count > 0 && ovG.data.material_count < 300, JSON.stringify(ovG.data.material_count))

  console.log('== 4. 单据/任务/盘点列表 ==')
  const obP = await callRaw('outbound', 'list', { page: 1, pageSize: 50 }, parts)
  const obG = await callRaw('outbound', 'list', { page: 1, pageSize: 50 }, goods)
  check('配件仓管出库单全在 wh1', (obP.data.list || []).every(o => o.warehouse_id === 1))
  check('成品仓管出库单全在 wh2', (obG.data.list || []).every(o => o.warehouse_id === 2))
  const ptP = await callRaw('purchase', 'list', { page: 1, pageSize: 50 }, parts)
  const ptG = await callRaw('purchase', 'list', { page: 1, pageSize: 50 }, goods)
  check('配件仓管采购任务全在 wh1', (ptP.data.list || []).every(t => t.warehouse_id === 1))
  check('成品仓管采购任务全在 wh2', (ptG.data.list || []).every(t => t.warehouse_id === 2))
  const ckP = await callRaw('check', 'list', { page: 1, pageSize: 50 }, parts)
  const ckG = await callRaw('check', 'list', { page: 1, pageSize: 50 }, goods)
  check('配件仓管盘点单全在 wh1', (ckP.data.list || []).every(c => c.warehouse_id === 1))
  check('成品仓管盘点单全在 wh2', (ckG.data.list || []).every(c => c.warehouse_id === 2))

  console.log('== 5. 跨仓写拦截 ==')
  // 2026-10-09：老板只读后 stats.stockList 已收回 boss（原用 dev_boss 取 wh2 物料会 403 崩），
  //   改用「成品仓管」（本身只管辖 wh2）取物料，再让配件仓管跨仓提交做拦截验证
  const m2 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 2 }, goods)).data.list[0]
  const crossSubmit = await callRaw('inbound', 'submit', { warehouse_id: 2, supplier_name: '隔离测试', items: [{ material_id: m2._id, quantity: 1, unit_price: 1 }] }, parts)
  check('配件仓管向成品仓开入库单被拒(403)', crossSubmit.code === 403, JSON.stringify(crossSubmit.code))

  console.log('== 6. 消息按仓投递 ==')
  // 领料员在 wh1 提交一张出库单 → 消息应只到配件仓管
  //
  // ⚠️ 判据必须用「提交前后的增量」，不能用「最近 1 分钟」：
  //    role-agent 主套件刚跑完时会留下 1 分钟内的 outbound_submitted 消息，
  //    用时间窗判定会把它算进来，出现与业务无关的假故障（2026-10-06 踩到）。
  const countP = async () => Number((await query(
    "SELECT COUNT(*) c FROM messages WHERE to_openid = 'dev_sk_parts' AND type = 'outbound_submitted'"))[0].c)
  const countG = async () => Number((await query(
    "SELECT COUNT(*) c FROM messages WHERE to_openid = 'dev_sk_goods' AND type = 'outbound_submitted'"))[0].c)

  const m1 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, out)).data.list[0]
  const baseP = await countP()
  const baseG = await countG()
  await callRaw('outbound', 'submit', { type: 'lingyong', items: [{ material_id: m1._id, quantity: 1 }] }, out)
  await new Promise(r => setTimeout(r, 800))
  const msgP = await countP()
  const msgG = await countG()
  check('wh1 出库单消息到配件仓管', msgP - baseP >= 1, `基线 ${baseP} → 现在 ${msgP}`)
  check('wh1 出库单消息不到成品仓管', msgG === baseG, `基线 ${baseG} → 现在 ${msgG}`)
  // 清理这张验证单
  const lastOrder = await query("SELECT id FROM outbound_orders WHERE operator_openid = 'dev_out' ORDER BY id DESC LIMIT 1")
  if (lastOrder.length) {
    await callRaw('outbound', 'cancel', { id: lastOrder[0].id, reason: '隔离验证' }, out)
    await execute('DELETE FROM outbound_order_items WHERE order_id = ?', [lastOrder[0].id])
    await execute('DELETE FROM outbound_orders WHERE id = ?', [lastOrder[0].id])
    await execute("DELETE FROM messages WHERE to_openid IN ('dev_sk_parts','dev_sk_goods') AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)")
  }

  console.log(`\n结果：${pass} 过 / ${fail} 挂`)
  autoCleanup()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); autoCleanup(); process.exit(1) })
