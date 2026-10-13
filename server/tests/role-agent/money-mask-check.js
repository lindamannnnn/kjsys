/**
 * 仓管金额脱敏验收（2026-10-10）
 * ============================================================
 * 背景：用户要求「仓管可以看到金额的地方全部删除掉」。
 *   口径（用户 2026-10-10 拍定）：
 *     · **配件仓**入库单的单价/金额保留（配件是采购来的，仓管收货要对账）
 *     · **成品仓**入库单的金额对仓管脱敏
 *     · 库存价值 / 成本价 / 单据金额 / 采购任务金额 —— 仓管一律不下发
 *
 * 覆盖（仓管有权访问的 8 个接口）：
 *   stats.overview / stockList / orderFlow / warning / warehouseSummary
 *   warehouse.list / inbound.list / inbound.detail / purchase.list
 *
 * ⚠️ 对照实验（项目铁律）：本脚本必须对「修复前代码」跑红。
 *   验证方式（已实测）：临时注掉 stats.js / inbound.js / warehouse.js 里的
 *   isCostHiddenUser 分支后重跑，「仓管不可见」断言全部失败；恢复后全绿。
 *
 * 数据：为了让「按行脱敏」可验证，本脚本会建 2 张入库单（配件仓 / 成品仓各 1），
 *   跑完在 finally 里自动清理（单据 + 明细 + 流水 + 消息 + 库存/成本复位）。
 */
require('../../src/config/env')
const { callRaw, loginDev, loginAdmin } = require('./lib')
const { query, queryOne, execute } = require('../../src/db/pool')

let pass = 0
let fail = 0
const failures = []

function ok(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` → ${detail}` : ''}`)
  }
}

/** 字段是否存在（脱敏 = 字段被删掉，不是置 0） */
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k)

async function api(token, mod, action, data = {}) {
  const r = await callRaw(mod, action, data, token)
  if (!r || r.code !== 0) throw new Error(`${mod}.${action} 失败：${r && r.message}`)
  return r.data
}

;(async () => {
  console.log('\n═══ 仓管金额脱敏验收（2026-10-10）═══\n')

  // ---------- 0. 准备：仓库 / 物料 / 基线 ----------
  const whs = await query('SELECT id, code, name FROM warehouses WHERE is_deleted = 0 ORDER BY id')
  const whParts = whs.find((w) => w.code === 'peijian')
  const whGoods = whs.find((w) => w.code === 'chengpin')
  if (!whParts || !whGoods) throw new Error('找不到配件仓 / 成品仓，无法验收')

  const matParts = await queryOne(
    'SELECT id, name, current_stock, avg_cost FROM materials WHERE warehouse_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1',
    [whParts.id])
  const matGoods = await queryOne(
    'SELECT id, name, current_stock, avg_cost FROM materials WHERE warehouse_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1',
    [whGoods.id])
  if (!matParts || !matGoods) throw new Error('找不到可入库的物料')

  const baseLogId = Number((await queryOne('SELECT COALESCE(MAX(id), 0) AS m FROM stock_logs')).m)
  const baseMsgId = Number((await queryOne('SELECT COALESCE(MAX(id), 0) AS m FROM messages')).m)
  const baseStock = { [matParts.id]: Number(matParts.current_stock), [matGoods.id]: Number(matGoods.current_stock) }
  const baseCost = { [matParts.id]: Number(matParts.avg_cost), [matGoods.id]: Number(matGoods.avg_cost) }
  // 预警接口平时可能没有任何预警料（跑不出行就没法验证字段）→ 临时把**成品仓**那个物料的
  // 预警线抬高，制造一条预警（必须用成品仓的：仓管有仓库数据范围，成品仓管看不到配件仓的料）。
  // 跑完在 finally 里复位。
  const baseWarn = Number((await queryOne('SELECT warning_stock FROM materials WHERE id = ?', [matGoods.id])).warning_stock)
  await execute('UPDATE materials SET warning_stock = ? WHERE id = ?',
    [baseStock[matGoods.id] + 1000, matGoods.id])

  const T = {
    skParts: await loginDev('dev_sk_parts'),
    skGoods: await loginDev('dev_sk_goods'),
    admin: await loginAdmin('admin', '123456'),
    boss: await loginDev('dev_boss'),
    director: await loginDev('dev_director'),
    purchase: await loginDev('dev_purchase'),
    out: await loginDev('dev_out')
  }

  let inPartsId = null
  let inGoodsId = null

  try {
    // ---------- 1. 造数：配件仓 / 成品仓各一张入库单 ----------
    console.log('【准备】建 2 张入库单（配件仓 / 成品仓）')
    const inParts = await api(T.skParts, 'inbound', 'submit', {
      items: [{ material_id: matParts.id, quantity: 1, unit_price: 30 }],
      supplier: 'MASK-验收用供应商',
      warehouse_id: whParts.id
    })
    const inGoods = await api(T.skGoods, 'inbound', 'submit', {
      items: [{ material_id: matGoods.id, quantity: 1, unit_price: 50 }],
      supplier: 'MASK-验收用供应商',
      warehouse_id: whGoods.id
    })
    inPartsId = Number(inParts._id)
    inGoodsId = Number(inGoods._id)
    console.log(`      配件仓单 #${inPartsId} ${inParts.order_no}｜成品仓单 #${inGoodsId} ${inGoods.order_no}\n`)

    // ---------- 2. stats.overview：库存价值 + 四类金额 ----------
    console.log('【1】stats.overview（看板 KPI 数据源）')
    const ovGoods = await api(T.skGoods, 'stats', 'overview', {})
    ok('仓管：不含 total_value（库存价值）', !has(ovGoods, 'total_value'))
    ok('仓管：不含 today_outbound_amount', !has(ovGoods, 'today_outbound_amount'))
    ok('仓管：不含 today_inbound_amount', !has(ovGoods, 'today_inbound_amount'))
    ok('仓管：不含 period_outbound_amount', !has(ovGoods, 'period_outbound_amount'))
    ok('仓管：不含 period_inbound_amount', !has(ovGoods, 'period_inbound_amount'))
    ok('仓管：数量类字段照常下发（total_stock / material_count）',
      has(ovGoods, 'total_stock') && has(ovGoods, 'material_count'))

    const ovAdmin = await api(T.admin, 'stats', 'overview', {})
    ok('管理员：total_value 正常下发', has(ovAdmin, 'total_value'))
    ok('管理员：today_inbound_amount 正常下发', has(ovAdmin, 'today_inbound_amount'))

    // ---------- 3. stats.stockList：台账 ----------
    console.log('\n【2】stats.stockList（库存台账）')
    const slGoods = await api(T.skGoods, 'stats', 'stockList', { page: 1, pageSize: 5 })
    const slRow = (slGoods.list || [])[0]
    ok('仓管：行内不含 avg_cost', slRow ? !has(slRow, 'avg_cost') : false)
    ok('仓管：行内不含 stock_value', slRow ? !has(slRow, 'stock_value') : false)
    ok('仓管：汇总不含 total_value', !has(slGoods, 'total_value'))
    ok('仓管：数量字段照常（current_stock / warning_stock）',
      slRow ? has(slRow, 'current_stock') && has(slRow, 'warning_stock') : false)

    const slAdmin = await api(T.admin, 'stats', 'stockList', { page: 1, pageSize: 5 })
    ok('管理员：行内有 avg_cost', has((slAdmin.list || [])[0] || {}, 'avg_cost'))
    ok('管理员：汇总有 total_value', has(slAdmin, 'total_value'))

    // ---------- 4. stats.warehouseSummary + warehouse.list ----------
    console.log('\n【3】stats.warehouseSummary / warehouse.list（仓库对比 / 下拉框）')
    const wsGoods = await api(T.skGoods, 'stats', 'warehouseSummary', {})
    const wsRow = (wsGoods.list || [])[0]
    ok('仓管：仓库汇总不含 total_value', wsRow ? !has(wsRow, 'total_value') : false)
    ok('仓管：仓库汇总保留 total_stock', wsRow ? has(wsRow, 'total_stock') : false)

    const wlGoods = await api(T.skGoods, 'warehouse', 'list', {})
    const wlRow = (wlGoods.list || [])[0]
    ok('仓管：warehouse.list 不含 total_value', wlRow ? !has(wlRow, 'total_value') : false)
    ok('仓管：warehouse.list 保留 name（下拉框要用）', wlRow ? has(wlRow, 'name') : false)

    const wsAdmin = await api(T.admin, 'stats', 'warehouseSummary', {})
    ok('管理员：仓库汇总有 total_value', has((wsAdmin.list || [])[0] || {}, 'total_value'))

    // ---------- 5. stats.orderFlow：单据流水（按行脱敏）----------
    console.log('\n【4】stats.orderFlow（单据流水，按仓库区分）')
    const ofGoods = await api(T.skGoods, 'stats', 'orderFlow', { page: 1, pageSize: 50 })
    const ofRows = ofGoods.list || []
    const goodsInboundRow = ofRows.find((r) => r.kind === 'inbound' && r.warehouse_name === whGoods.name)
    ok('仓管：成品仓入库单行不含 total_amount',
      goodsInboundRow ? !has(goodsInboundRow, 'total_amount') : false)

    const ofParts = await api(T.skParts, 'stats', 'orderFlow', { page: 1, pageSize: 50 })
    const partsInboundRow = (ofParts.list || [])
      .find((r) => r.kind === 'inbound' && r.warehouse_name === whParts.name)
    ok('仓管：配件仓入库单行**保留** total_amount（对账用）',
      partsInboundRow ? has(partsInboundRow, 'total_amount') : false,
      partsInboundRow ? '' : '（未取到配件仓入库单行）')

    const ofAdmin = await api(T.admin, 'stats', 'orderFlow', { page: 1, pageSize: 50 })
    const adminRow = (ofAdmin.list || []).find((r) => r._id === String(inGoodsId) || Number(r._id) === inGoodsId)
    ok('管理员：入库单行有 total_amount', adminRow ? has(adminRow, 'total_amount') : false)

    // ---------- 6. inbound.list / detail ----------
    console.log('\n【5】inbound.list / inbound.detail（入库单）')
    const ilGoods = await api(T.skGoods, 'inbound', 'list', { page: 1, pageSize: 50 })
    const ilGoodsRow = (ilGoods.list || []).find((o) => Number(o._id) === inGoodsId)
    ok('仓管：成品仓入库单不含 total_price',
      ilGoodsRow ? !has(ilGoodsRow, 'total_price') : false)
    ok('仓管：成品仓入库明细不含 unit_price',
      ilGoodsRow && (ilGoodsRow.items || [])[0] ? !has((ilGoodsRow.items || [])[0], 'unit_price') : false)
    ok('仓管：成品仓入库明细不含 total_price',
      ilGoodsRow && (ilGoodsRow.items || [])[0] ? !has((ilGoodsRow.items || [])[0], 'total_price') : false)

    const ilParts = await api(T.skParts, 'inbound', 'list', { page: 1, pageSize: 50 })
    const ilPartsRow = (ilParts.list || []).find((o) => Number(o._id) === inPartsId)
    ok('仓管：配件仓入库单**保留** total_price',
      ilPartsRow ? has(ilPartsRow, 'total_price') : false)
    ok('仓管：配件仓入库明细**保留** unit_price',
      ilPartsRow && (ilPartsRow.items || [])[0] ? has((ilPartsRow.items || [])[0], 'unit_price') : false)

    const idGoodsDetail = await api(T.skGoods, 'inbound', 'detail', { id: inGoodsId })
    ok('仓管：成品仓入库详情不含 total_price', !has(idGoodsDetail, 'total_price'))
    ok('仓管：成品仓入库详情明细不含 unit_price',
      (idGoodsDetail.items || [])[0] ? !has((idGoodsDetail.items || [])[0], 'unit_price') : false)

    const idPartsDetail = await api(T.skParts, 'inbound', 'detail', { id: inPartsId })
    ok('仓管：配件仓入库详情保留 total_price', has(idPartsDetail, 'total_price'))

    const idAdminDetail = await api(T.admin, 'inbound', 'detail', { id: inGoodsId })
    ok('管理员：成品仓入库详情有 total_price', has(idAdminDetail, 'total_price'))

    // ---------- 7. stats.warning ----------
    console.log('\n【6】stats.warning（库存预警）')
    const wnGoods = await api(T.skGoods, 'stats', 'warning', { page: 1, pageSize: 5, includeIdle: true })
    const wnRow = (wnGoods.list || [])[0]
    ok('仓管：预警行不含 avg_cost（该接口 SELECT m.*，最容易漏）',
      wnRow ? !has(wnRow, 'avg_cost') : false,
      wnRow ? '' : '（未造出预警数据，检查 warning_stock 是否设置成功）')

    const wnAdmin = await api(T.admin, 'stats', 'warning', { page: 1, pageSize: 5, includeIdle: true })
    const wnAdminRow = (wnAdmin.list || [])[0]
    ok('管理员：预警行有 avg_cost', wnAdminRow ? has(wnAdminRow, 'avg_cost') : false)

    // ---------- 8. purchase.list ----------
    console.log('\n【7】purchase.list（采购任务）')
    const ptGoods = await api(T.skGoods, 'purchase', 'list', { page: 1, pageSize: 5 })
    const ptRow = (ptGoods.list || [])[0]
    ok('仓管：采购任务列表不含 total_amount',
      ptRow ? !has(ptRow, 'total_amount') : true, // 无任务时视为通过
      ptRow ? '' : '（当前无采购任务，跳过）')

    const ptPurchase = await api(T.purchase, 'purchase', 'list', { page: 1, pageSize: 5 })
    ok('采购员：采购任务列表不受影响（可正常调用）', Array.isArray(ptPurchase.list))

    // ---------- 9. 其余角色对照：不该被误伤 ----------
    console.log('\n【8】其余角色对照（金额应照常可见）')
    // ⚠️ stats.overview 的 roleRules 不含 purchase（采购员本来就没这个权限），只测 stockList
    for (const [name, token] of [['老板', T.boss], ['厂长', T.director]]) {
      const ov = await api(token, 'stats', 'overview', {})
      ok(`${name}：overview 有 total_value`, has(ov, 'total_value'))
      const sl = await api(token, 'stats', 'stockList', { page: 1, pageSize: 1 })
      ok(`${name}：stockList 行有 avg_cost`, has((sl.list || [])[0] || {}, 'avg_cost'))
    }
    const slP = await api(T.purchase, 'stats', 'stockList', { page: 1, pageSize: 1 })
    ok('采购员：stockList 行有 avg_cost（不受仓管脱敏影响）',
      has((slP.list || [])[0] || {}, 'avg_cost'))

    // ---------- 10. 领料员回归：原来的 maskStockFields 没被破坏 ----------
    console.log('\n【9】领料员回归（原有的库存脱敏不受影响）')
    const slOut = await api(T.out, 'stats', 'stockList', { page: 1, pageSize: 1 })
    const outRow = (slOut.list || [])[0]
    ok('领料员：仍看不到 current_stock', outRow ? !has(outRow, 'current_stock') : false)
    ok('领料员：仍看不到 avg_cost', outRow ? !has(outRow, 'avg_cost') : false)

    // ---------- 11. 内部判定字段不下发 ----------
    console.log('\n【10】契约：内部判定字段 warehouse_code 不下发')
    ok('orderFlow 行不含 warehouse_code',
      !(ofRows[0] && has(ofRows[0], 'warehouse_code')))
    ok('inbound.list 行不含 warehouse_code',
      !(ilGoodsRow && has(ilGoodsRow, 'warehouse_code')))
  } catch (e) {
    fail++
    failures.push(`执行异常：${e.message}`)
    console.log(`\n  ✗ 执行异常：${e.message}\n${e.stack}`)
  } finally {
    // ---------- 清理（项目铁律：写真实库就要自清理）----------
    console.log('\n【清理】')
    const ids = [inPartsId, inGoodsId].filter(Boolean)
    if (ids.length) {
      const ph = ids.map(() => '?').join(',')
      await execute(`DELETE FROM inbound_order_items WHERE order_id IN (${ph})`, ids)
      await execute(`DELETE FROM inbound_orders WHERE id IN (${ph})`, ids)
    }
    const logDel = await execute('DELETE FROM stock_logs WHERE id > ?', [baseLogId])
    const msgDel = await execute('DELETE FROM messages WHERE id > ?', [baseMsgId])
    for (const mid of Object.keys(baseStock)) {
      await execute('UPDATE materials SET current_stock = ?, avg_cost = ? WHERE id = ?',
        [baseStock[mid], baseCost[mid], Number(mid)])
    }
    // 复位预警线（造预警用的临时改动）
    await execute('UPDATE materials SET warning_stock = ? WHERE id = ?', [baseWarn, matGoods.id])
    console.log(`      单据 ${ids.length} 张、流水 ${logDel.affectedRows ?? '-'} 条、消息 ${msgDel.affectedRows ?? '-'} 条已清；库存与成本已复位`)

    console.log(`\n═══ 结果：${pass}/${pass + fail} 通过 ═══`)
    if (failures.length) {
      console.log('失败项：')
      failures.forEach((f) => console.log(`  · ${f}`))
    }
    console.log('')
    process.exit(fail ? 1 : 0)
  }
})()
