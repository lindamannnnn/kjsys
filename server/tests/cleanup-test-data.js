/**
 * ============================================================
 * 测试数据清理 + 库存初始化
 * ------------------------------------------------------------
 * 用法：
 *   node tests/cleanup-test-data.js           # 预演（只打印，不动数据）
 *   node tests/cleanup-test-data.js --apply   # 真删（先自动备份全表到 _bak_20261005_*）
 *
 * 删什么（全是带测试标记/探针性质的）：
 *   - 物料：[RA / [V3 / [V2 / 【测试】/ 链路测试 / 收料UI / spec TEST-* / RA-* / [PPO*
 *   - 供应商：名字带 [RA / [V3 / [V2 / [V5 / 【测试】/ 链路测试 / E2E 前缀的
 *     ⚠️ 供应商必须一起清：supplier.search 是 `ORDER BY name LIMIT 20`，
 *        残留几十条 `[RA-Rn]测试供应商-*` 后新造的那条会被挤到 20 名之外，
 *        role-agent 的「供应商能搜到」就会挂 —— 与业务代码无关的假故障（2026-10-06 踩到）
 *   - 单据：入库单、出库单、采购任务、盘点单中 remark 带标记的、或明细含测试物料的
 *   - 盘点单另含 E2E 残留（CHK-20261001-004 等 remark 带 E2E 的）
 *   - 探针账号：dev_v3fix_* / dev_ra_pending_* / RA_* / V3FIX_*
 *   - 消息：内容带标记 / 发给探针 / 关联被删单据
 *   - 操作日志：带标记 / 探针账号 / 全部越权拒绝类（permission_denied/auth_required）
 *   - [RA 开头的测试仓库（硬删，本来已软删）
 *   - 相关的库存流水（测试物料的 + 被删单据的；system 的初始化条保留）
 *
 * ⚠️ 2026-10-12 重大整改（误删用户真实单据后）：
 *   **绝不再按「dev_* 账号」删任何东西**（原 DEV_IN/OUT/TASK/CHECK + 流水 + 消息 + 日志的 dev_ 口径全撤）。
 *   原因：用户开发联调也用 dev_* 身份做**真实操作**，按账号删会把真实单据误当测试垃圾。
 *   现在**只认测试标记**（MARK_NAME / MARK_REMARK / MARK_SUPPLIER）。
 *   → 因此**测试脚本建单必须带标记 remark**（已抽查 run.js / roles/* 全部带 `${mark}`），否则清不掉。
 *
 * 保留：真实物料、真实（未标记）单据与消息、admin、dev_out/dev_sk/dev_purchase/dev_boss/dev_worker_01
 *       ⚠️ dev_* 账号本身保留（小程序调试入口要用），它们产生的**无标记**单据/流水/消息/日志也**全部保留**。
 *
 * 库存处理：**只回补「本次删掉的测试单据」对真实物料造成的净变动**（delta 在删流水前算），
 *   `current_stock = current_stock - delta`；**不写流水**（见下方第 4 步说明）。
 *   ⚠️ 不再「把 current_stock<>10 的一律复位回 10」——那会冲掉用户真实库存。
 * ============================================================
 */
require('../src/config/env')
const { query, queryOne, execute } = require('../src/db/pool')
const { assertDestructive } = require('../src/db/destructive-guard')

const APPLY = process.argv.includes('--apply')
/**
 * 备份表前缀带**时间戳**。
 * ⚠️ 原来写死 `_bak_20261005`，而建表用的是 `CREATE TABLE IF NOT EXISTS` ——
 *   跑第二次时表已存在，直接跳过：备份还是第一次那份，第二次删掉的数据**没有任何备份**，
 *   而且报出来的「备份完成」让人以为很安全。实测中招过（2026-10-09 大屏演示数据清理时发现）。
 *   时间戳让每次 --apply 都写自己那一份，永远不覆盖。
 */
const BAK = `_bak_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`

const MARK_NAME = [
  "name LIKE '[RA%'", "name LIKE '[V3%'", "name LIKE '[V2%'", "name LIKE '【测试】%'",
  "name LIKE '链路测试%'", "name LIKE '收料UI%'", "name LIKE '%测试物料%'",
  "name LIKE 'E2E%'", "category LIKE 'E2E%'", "sub_category LIKE 'E2E%'",
  "name LIKE '[V5%'", "spec LIKE 'V5-%'",
  "name LIKE '[PPO%'", "spec LIKE 'PPO-%'",
  // 2026-10-12 补：早期探针留下的前缀（`GAPTEST*` / `【V3-*】`），以前漏了
  "name LIKE 'GAPTEST%'", "name LIKE '【V3%'", "name LIKE '【复核】%'",
  "spec LIKE 'TEST-%'", "spec LIKE 'RA-%'"
].join(' OR ')
// 带表别名，避免 JOIN 后 remark 歧义
const MARK_REMARK = (a) => [
  `${a}.remark LIKE '%[RA%'`, `${a}.remark LIKE '%[V3%'`, `${a}.remark LIKE '%[V2%'`, `${a}.remark LIKE '%E2E%'`,
  `${a}.remark LIKE '%链路测试%'`, `${a}.remark LIKE '%收料UI%'`, `${a}.remark LIKE '%[V5%'`, `${a}.remark LIKE '%[PPO%'`,
  // 2026-10-13 补：mp-review.js 的建单标记，以前漏了 → 跑完残留采购任务/出库单
  `${a}.remark LIKE '%MP-REVIEW%'`,
  // 2026-10-13 补：mp-full-flow.js 全流程真实提交测试的标记
  `${a}.remark LIKE '%FULLFLOW%'`
].join(' OR ')
const PROBE_USER = [
  "openid LIKE 'dev_v3fix%'", "openid LIKE 'dev_ra_pending%'",
  "username LIKE 'RA_%'", "username LIKE 'V3FIX_%'",
  "username LIKE 'V3R%'", "username LIKE 'V3RECHECK%'", "username LIKE 'AUTOTEST_%'"
].join(' OR ')

// 测试供应商：role-agent 每轮都建一条，但原先这里没有清理入口，
// 攒够 20 条以上就会把新造的那条挤出 supplier.search 的 LIMIT 20（见文件头说明）
const MARK_SUPPLIER = [
  "name LIKE '[RA%'", "name LIKE '[V3%'", "name LIKE '[V2%'", "name LIKE '[V5%'",
  "name LIKE '【测试】%'", "name LIKE '链路测试%'", "name LIKE 'E2E%'",
  // 2026-10-12 补：早期探针留下的（`GAPTEST供应商*` / `【V3-R3】后台探针供应商`）
  "name LIKE 'GAPTEST%'", "name LIKE '【V3%'", "name LIKE '%探针供应商%'"
].join(' OR ')

const report = []
async function step(label, countSql, applySql, params = []) {
  const n = Number((await queryOne(countSql, params)).c)
  let done = 0
  if (APPLY && n > 0) done = (await execute(applySql, params)).affectedRows
  report.push(`${label}: ${n} 条${APPLY ? ` → 已处理 ${done}` : ''}`)
  return n
}

async function main() {
  // ⛔ 安全闸门（默认拒绝）：只有「非生产 + 显式开启」才继续
  assertDestructive('清理测试数据', '将物理删除带测试标记的物料/单据/流水/消息（先自动备份）')

  console.log(APPLY ? '=== 真删模式（先备份） ===' : '=== 预演模式（不动数据） ===')

  // 0. 备份
  if (APPLY) {
    const tables = ['materials', 'stock_logs', 'inbound_orders', 'inbound_order_items',
      'outbound_orders', 'outbound_order_items', 'purchase_tasks', 'purchase_task_items',
      'stock_checks', 'stock_check_items', 'messages', 'operation_logs', 'users', 'warehouses',
      'suppliers']
    for (const t of tables) {
      await execute(`CREATE TABLE IF NOT EXISTS ${BAK}_${t} AS SELECT * FROM ${t}`)
    }
    console.log(`备份完成：${BAK}_*（${tables.length} 张表）`)
  }

  // 1. 找出测试物料 id
  const testMats = await query(`SELECT id FROM materials WHERE ${MARK_NAME}`)
  const testIds = testMats.map((r) => r.id)
  const inTest = testIds.length ? testIds.map(() => '?').join(',') : 'NULL'
  report.push(`测试物料: ${testIds.length} 个`)
  const testSups = await query(`SELECT id FROM suppliers WHERE ${MARK_SUPPLIER}`)
  report.push(`测试供应商: ${testSups.length} 个`)

  // 2. 单据：找出要删的（标记 remark 或 明细含测试物料）
  // ⚠️ 2026-10-12 整改：**去掉「按 dev_* 操作员删单」的口径**（原 2026-10-09 补的 DEV_IN/OUT/TASK/CHECK）。
  //   原意是清测试脚本用 dev_* 建在真实物料上的残留单据，但用户开发联调也用 dev_* 身份做真实操作
  //   （2026-10-12 误删用户真实出库单 OUT-20261012-001，查明：operator_openid=dev_out 命中 DEV_OUT）。
  //   现在只认「测试标记 remark / 明细含测试物料」——用户用 dev_* 亲手做的单不再动。
  //   前提：测试脚本建单必须带标记 remark（已抽查 run.js/roles/* 全部带 ${mark}）。
  const inOrders = await query(
    `SELECT DISTINCT o.id, o.order_no FROM inbound_orders o
      LEFT JOIN inbound_order_items i ON i.order_id = o.id
     WHERE ${MARK_REMARK('o')} OR i.material_id IN (${inTest})`, testIds)
  const outOrders = await query(
    `SELECT DISTINCT o.id, o.order_no FROM outbound_orders o
      LEFT JOIN outbound_order_items i ON i.order_id = o.id
     WHERE ${MARK_REMARK('o')} OR i.material_id IN (${inTest})`, testIds)
  const pTasks = await query(
    `SELECT DISTINCT t.id, t.task_no FROM purchase_tasks t
      LEFT JOIN purchase_task_items i ON i.task_id = t.id
     WHERE ${MARK_REMARK('t')} OR i.material_id IN (${inTest})`, testIds)
  const checks = await query(
    `SELECT DISTINCT c.id, c.check_no FROM stock_checks c
      LEFT JOIN stock_check_items i ON i.check_id = c.id
     WHERE ${MARK_REMARK('c')} OR i.material_id IN (${inTest})`, testIds)

  const inIds = inOrders.map((r) => r.id), inNos = inOrders.map((r) => r.order_no)
  const outIds = outOrders.map((r) => r.id), outNos = outOrders.map((r) => r.order_no)
  const pIds = pTasks.map((r) => r.id), pNos = pTasks.map((r) => r.task_no)
  const cIds = checks.map((r) => r.id), cNos = checks.map((r) => r.check_no)
  const allNos = [...inNos, ...outNos, ...pNos, ...cNos]
  report.push(`入库单 ${inIds.length} / 出库单 ${outIds.length} / 采购任务 ${pIds.length} / 盘点单 ${cIds.length}`)

  const inList = (arr) => arr.length ? arr.map(() => '?').join(',') : 'NULL'

  // 本次要删的流水对**真实物料**的净影响（库存回录用，必须在删流水之前算）。
  // 只统计「被删单据」的流水；测试物料的流水不统计（测试物料反正要硬删，不用回补）。
  const stockDelta = allNos.length ? await query(
    `SELECT material_id, SUM(change_quantity) AS delta FROM stock_logs
      WHERE related_order_id IN (${inList(allNos)}) GROUP BY material_id`, allNos) : []

  if (APPLY) {
    // 3. 按外键顺序删（明细 → 主单 → 流水 → 消息 → 日志 → 用户 → 物料）
    if (inIds.length) {
      await execute(`DELETE FROM inbound_order_items WHERE order_id IN (${inList(inIds)})`, inIds)
      await execute(`DELETE FROM inbound_orders WHERE id IN (${inList(inIds)})`, inIds)
    }
    if (outIds.length) {
      await execute(`DELETE FROM outbound_order_items WHERE order_id IN (${inList(outIds)})`, outIds)
      await execute(`DELETE FROM outbound_orders WHERE id IN (${inList(outIds)})`, outIds)
    }
    if (pIds.length) {
      await execute(`DELETE FROM purchase_task_items WHERE task_id IN (${inList(pIds)})`, pIds)
      await execute(`DELETE FROM purchase_tasks WHERE id IN (${inList(pIds)})`, pIds)
    }
    if (cIds.length) {
      await execute(`DELETE FROM stock_check_items WHERE check_id IN (${inList(cIds)})`, cIds)
      await execute(`DELETE FROM stock_checks WHERE id IN (${inList(cIds)})`, cIds)
    }
    // 流水：测试物料的 + 被删单据的（system 的库存初始化保留）
    // ⚠️ 2026-10-12 整改：去掉「dev_ 账号经手」口径 —— 用户用 dev_* 做的真实单据流水不能删
    await execute(
      `DELETE FROM stock_logs
        WHERE material_id IN (${inTest})
           OR related_order_id IN (${inList(allNos)})`,
      [...testIds, ...allNos])
    // 消息：带标记 / 发探针 / 关联单已不存在的孤儿消息
    // ⚠️ 2026-10-12：去掉 `to_openid LIKE 'dev_%'`（会删掉用户用 dev_* 收到的真实通知）
    await execute(
      `DELETE FROM messages WHERE title LIKE '%[RA%' OR title LIKE '%[V3%' OR title LIKE '%[V2%'
        OR content LIKE '%[RA%' OR content LIKE '%[V3%' OR content LIKE '%[V2%'
        OR title LIKE '%MP-REVIEW%' OR content LIKE '%MP-REVIEW%'
        OR content LIKE '%E2E%' OR to_openid LIKE 'dev_v3fix%' OR to_openid LIKE 'dev_ra_pending%'
        OR ref_no IN (${inList(allNos)})
        OR (ref_no <> '' AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT order_no AS no_ FROM inbound_orders
            UNION ALL SELECT order_no FROM outbound_orders
            UNION ALL SELECT task_no FROM purchase_tasks
            UNION ALL SELECT check_no FROM stock_checks
          ) x WHERE x.no_ = messages.ref_no))`, allNos)
    // 日志：带标记 / 探针（探针日志的 openid 字段存的是 username）/ 越权拒绝类
    // ⚠️ 2026-10-12：去掉 `openid LIKE 'dev_%'`（会删掉用户用 dev_* 的真实操作日志）
    await execute(
      `DELETE FROM operation_logs WHERE detail LIKE '%[RA%' OR detail LIKE '%[V3%' OR detail LIKE '%[V2%'
        OR detail LIKE '%MP-REVIEW%' OR detail LIKE '%E2E%' OR openid LIKE 'RA_%' OR openid LIKE 'V3FIX_%'
        OR action IN ('permission_denied', 'auth_required')`)
    // 探针账号
    await execute(`DELETE FROM users WHERE ${PROBE_USER}`)
    // 测试供应商（不删会挤爆 supplier.search 的 LIMIT 20）
    await execute(`DELETE FROM suppliers WHERE ${MARK_SUPPLIER}`)
    // 测试仓（含已软删的）
    await execute(`DELETE FROM warehouses WHERE name LIKE '[RA%' OR code LIKE 'RA%'`)
    // 测试物料（硬删）
    if (testIds.length) await execute(`DELETE FROM materials WHERE id IN (${inTest})`, testIds)
  }

  // 4. 库存回补（2026-10-12 整改）：**只回补「本次删掉的测试单据」对真实物料造成的净变动**。
  //    ⚠️ 原先是把「所有 current_stock<>10 的物料」一律改回 10 —— 用户真实使用后会
  //      把整个库的真实库存全冲掉（2026-10-12 曾把用户出库扣掉的 4 个物料从 9 重置回 10）。
  //    现在：current_stock = current_stock - 本次被删流水的净变动，账面与流水保持一致。
  //    不写流水（恢复测试扰动，不是业务动作，不该进流水账）。
  if (APPLY && stockDelta.length) {
    let adjusted = 0
    for (const a of stockDelta) {
      // delta 是被删测试单据造成的净变动，减掉即还原；真实物料才回补，测试物料已在上一步硬删
      await execute(
        'UPDATE materials SET current_stock = current_stock - ? WHERE id = ? AND is_deleted = 0',
        [a.delta, a.material_id])
      adjusted++
    }
    report.push(`库存回补（被删测试单据净变动）: ${adjusted} 个物料`)
  } else {
    report.push('库存回补: 无需（本次没删到影响真实物料的单据）')
  }

  console.log('\n' + report.join('\n'))
  console.log(APPLY ? '\n✅ 清理完成' : '\n（预演结束，加 --apply 真删）')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
