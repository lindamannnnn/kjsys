/**
 * ============================================================
 * V2 测试数据清理
 * ------------------------------------------------------------
 * 设计原则（护栏优先）：
 *   1. **先验证真实数据没被污染，再动手删**。任一护栏不过就中止，什么都不删。
 *   2. 只删「带测试标记」的记录：remark 含 [V2-SETUP] / [RECHECK] / [VERIFY]
 *   3. 默认**预演**，只有显式 `--apply` 才真正删库
 *
 * 删什么：
 *   · 带标记的出库单及其明细
 *   · 带标记的采购任务及其明细
 *   · 上面这些单据产生的库存流水（按测试物料限定）
 * 不删什么：
 *   · 【测试】物料本身（留着方便下次测试，需要时可加 --with-materials）
 *   · 任何非测试数据
 *
 * 用法：
 *   node tests/v2-test-cleanup.js            # 预演
 *   node tests/v2-test-cleanup.js --apply    # 真删
 *   node tests/v2-test-cleanup.js --apply --with-materials   # 连测试物料一起删
 * ============================================================
 */
require('../src/config/env')

const { query, queryOne, execute } = require('../src/db/pool')
const { assertDestructive } = require('../src/db/destructive-guard')

const APPLY = process.argv.includes('--apply')
const WITH_MATERIALS = process.argv.includes('--with-materials')
// 历次测试的标记都保留，这样任何一轮的残留都能一次清干净
const MARKS = ['[V2-SETUP]', '[RECHECK]', '[VERIFY]', '[V3-SETUP]', '[V3-R1]', '[V3-R2]', '[V3-R3]', '[V3-P0]']

const markWhere = (col = 'remark') => MARKS.map(() => `${col} LIKE ?`).join(' OR ')
const markParams = () => MARKS.map((m) => `%${m}%`)

async function main() {
  // ⛔ 安全闸门：只有「非生产 + 显式开启」才继续
  if (APPLY) assertDestructive('V2 测试数据清理', '将按历史标记删除测试单据/物料/流水')

  console.log('='.repeat(66))
  console.log(`  V2 测试数据清理  ${APPLY ? '【正式执行】' : '【预演，不删任何东西】'}`)
  console.log('='.repeat(66))

  // ============================================================
  // 护栏：真实数据有没有被污染
  //
  // ⚠️ 修（2026-10-03 二次测试）：原护栏「近 12 小时有非测试物料流水就中止」，
  //    把「用户授权灌入的模拟库存」也当成污染 → 每次灌完数据清理都会被拦。
  //    现在把带 [模拟数据] 标记 / 操作人=模拟数据 的流水视为**已知的授权写入**豁免，
  //    但豁免数量会打印出来（不静默放过），其余真实业务流水仍一律拦。
  // ============================================================
  console.log('\n[护栏] 检查真实物料是否被测试动过')
  const SIM_EXEMPT = `(COALESCE(remark,'') LIKE '%[模拟数据]%' OR COALESCE(operator_name,'') = '模拟数据')`
  const RECENT = `created_at > NOW() - INTERVAL 12 HOUR`

  const exempted = await queryOne(
    `SELECT COUNT(*) AS c FROM stock_logs
      WHERE material_name NOT LIKE '【测试】%' AND ${RECENT} AND ${SIM_EXEMPT}`
  )
  if (Number(exempted.c) > 0) {
    console.log(`  ℹ️  豁免 ${exempted.c} 条「模拟库存」流水（remark/操作人含「模拟数据」，属已授权写入，不算污染）`)
  }

  const polluted = await query(
    `SELECT material_name, change_type, change_quantity, operator_name, remark, created_at
       FROM stock_logs
      WHERE material_name NOT LIKE '【测试】%'
        AND ${RECENT}
        AND NOT ${SIM_EXEMPT}
      ORDER BY id DESC LIMIT 20`
  )
  if (polluted.length) {
    console.log(`  ❌ 发现 ${polluted.length} 条**非测试物料**的库存流水（近 12 小时）：`)
    polluted.forEach((p) =>
      console.log(`     ${p.material_name} ${p.change_type} ${p.change_quantity} by ${p.operator_name} @ ${p.created_at}`)
    )
    console.log('\n  ⛔ 护栏未通过：真实数据可能已被污染，出于安全**中止清理**。')
    console.log('     请人工确认这些流水是不是正常的业务操作，再决定如何处理。')
    process.exit(2)
  }
  console.log('  ✅ 近 12 小时没有任何非测试物料的库存变动 → 真实数据未被污染，继续')

  // ============================================================
  // 统计待删数据
  // ============================================================
  console.log('\n[统计] 待清理的测试数据')

  const outOrders = await query(
    `SELECT id, order_no, status FROM outbound_orders WHERE is_deleted = 0 AND (${markWhere()})`,
    markParams()
  )
  const purTasks = await query(
    `SELECT id, task_no, status FROM purchase_tasks WHERE is_deleted = 0 AND (${markWhere()})`,
    markParams()
  )
  const testMats = await query(`SELECT id, name FROM materials WHERE is_deleted = 0 AND name LIKE '【测试】%'`)

  const outIds = outOrders.map((o) => o.id)
  const purIds = purTasks.map((p) => p.id)
  const matIds = testMats.map((m) => m.id)

  const outItems = outIds.length
    ? await queryOne(`SELECT COUNT(*) AS c FROM outbound_order_items WHERE order_id IN (${outIds.map(() => '?').join(',')})`, outIds)
    : { c: 0 }
  const purItems = purIds.length
    ? await queryOne(`SELECT COUNT(*) AS c FROM purchase_task_items WHERE task_id IN (${purIds.map(() => '?').join(',')})`, purIds)
    : { c: 0 }
  const logs = matIds.length
    ? await queryOne(`SELECT COUNT(*) AS c FROM stock_logs WHERE material_id IN (${matIds.map(() => '?').join(',')})`, matIds)
    : { c: 0 }

  console.log(`  出库单（带标记）    ：${outOrders.length} 张`)
  outOrders.slice(0, 8).forEach((o) => console.log(`      ${o.order_no}  ${o.status}`))
  if (outOrders.length > 8) console.log(`      …… 其余 ${outOrders.length - 8} 张`)
  console.log(`  出库单明细          ：${outItems.c} 行`)
  console.log(`  采购任务（带标记）  ：${purTasks.length} 个`)
  purTasks.slice(0, 8).forEach((p) => console.log(`      ${p.task_no}  ${p.status}`))
  if (purTasks.length > 8) console.log(`      …… 其余 ${purTasks.length - 8} 个`)
  console.log(`  采购任务明细        ：${purItems.c} 行`)
  console.log(`  测试物料            ：${testMats.length} 个${WITH_MATERIALS ? '（将一并删除）' : '（保留，下次测试还用得上）'}`)
  console.log(`  测试物料的库存流水  ：${logs.c} 条`)

  if (!APPLY) {
    console.log('\n' + '='.repeat(66))
    console.log('  预演结束，未改动任何数据')
    console.log('  确认无误后加 --apply 正式执行')
    console.log('='.repeat(66) + '\n')
    return
  }

  // ============================================================
  // 正式执行
  // ============================================================
  console.log('\n[执行] 开始清理…')

  if (outIds.length) {
    const ph = outIds.map(() => '?').join(',')
    await execute(`DELETE FROM outbound_order_items WHERE order_id IN (${ph})`, outIds)
    await execute(`DELETE FROM outbound_orders WHERE id IN (${ph})`, outIds)
    console.log(`  ✓ 已删除 ${outIds.length} 张出库单及其明细`)
  }
  if (purIds.length) {
    const ph = purIds.map(() => '?').join(',')
    await execute(`DELETE FROM purchase_task_items WHERE task_id IN (${ph})`, purIds)
    await execute(`DELETE FROM purchase_tasks WHERE id IN (${ph})`, purIds)
    console.log(`  ✓ 已删除 ${purIds.length} 个采购任务及其明细`)
  }
  if (WITH_MATERIALS && matIds.length) {
    const ph = matIds.map(() => '?').join(',')
    await execute(`DELETE FROM stock_logs WHERE material_id IN (${ph})`, matIds)
    await execute(`DELETE FROM materials WHERE id IN (${ph})`, matIds)
    console.log(`  ✓ 已删除 ${matIds.length} 个测试物料及其流水`)
  } else if (matIds.length) {
    console.log(`  · 测试物料保留（如要删除请加 --with-materials）`)
  }

  // ============================================================
  // 复核
  // ============================================================
  console.log('\n[复核] 清理后的残留')
  const leftOut = await queryOne(
    `SELECT COUNT(*) AS c FROM outbound_orders WHERE is_deleted = 0 AND (${markWhere()})`,
    markParams()
  )
  const leftPur = await queryOne(
    `SELECT COUNT(*) AS c FROM purchase_tasks WHERE is_deleted = 0 AND (${markWhere()})`,
    markParams()
  )
  const leftMats = await queryOne(`SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND name LIKE '【测试】%'`)
  const realMats = await queryOne(`SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND name NOT LIKE '【测试】%'`)

  console.log(`  带标记出库单残留：${leftOut.c}  （应为 0）`)
  console.log(`  带标记采购任务残留：${leftPur.c}  （应为 0）`)
  console.log(`  测试物料剩余：${leftMats.c}  ${WITH_MATERIALS ? '（应为 0）' : '（预期保留）'}`)
  console.log(`  真实物料：${realMats.c} 条（应远大于 0，证明真实数据没被误删）`)

  const ok = leftOut.c === 0 && leftPur.c === 0 && (WITH_MATERIALS ? leftMats.c === 0 : true) && realMats.c > 1000
  console.log(`\n  ${ok ? '✅ 复核通过' : '❌ 复核异常，请人工检查'}\n`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n[清理失败]', e.message)
    process.exit(1)
  })
