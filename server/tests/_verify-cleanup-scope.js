/**
 * 验证 cleanup 整改后的识别口径（2026-10-12）
 * ============================================================
 * 整改：cleanup 不再按「dev_* 账号」删单据，只认「测试标记 remark / 测试物料」。
 * 本脚本验证：**无标记的 dev_ 单据（用户真实操作）不再被删，带标记的仍会被删**。
 *
 * 方法：造两张出库单（一张无标记模拟用户、一张带 [RA] 标记），真跑 cleanup --apply，
 *       然后查库：无标记的应该还在、带标记的应该没了。跑完删掉无标记那张，不留现场。
 *
 * 用法：node tests/_verify-cleanup-scope.js
 *
 * ⚠️ 2026-10-12 环境坑（本机实测）：
 *   `spawnSync(child, {encoding:'utf8'})`（**管道 stdio**）在本机**必报 EBUSY**
 *   —— cmd.exe / node.exe / 系统 node 全都一样，不是偶发。
 *   但 `spawnSync(child, {stdio:'inherit'})` **正常**（`_cleanup.js` 的 autoCleanup 用的就是这个，所以它没坏）。
 *   → 本机起子进程一律用 `stdio:'inherit'`；要抓输出就落盘再读，别用管道。
 * ============================================================
 */
require('../src/config/env')
const { queryOne, execute } = require('../src/db/pool')
const { spawnSync } = require('child_process')
const path = require('path')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label, detail) }
}

;(async () => {
  console.log('═══ cleanup 口径整改验证（2026-10-12）═══\n')

  // 先清掉可能残留的同名单（上次中断可能留下）
  await execute(`DELETE FROM outbound_orders WHERE order_no IN ('OUT-VERIFY-KEEP','OUT-VERIFY-MARK')`)

  // 造两张：无标记（模拟用户用 dev_out 真实操作）+ 带 [RA] 标记（测试数据）
  await execute(`INSERT INTO outbound_orders (order_no, warehouse_id, type, status, operator_openid, operator_name, remark, is_deleted, created_at, updated_at)
    VALUES ('OUT-VERIFY-KEEP', 1, 'lingyong', 'pending', 'dev_out', '开发·领料员', '', 0, NOW(), NOW())`)
  await execute(`INSERT INTO outbound_orders (order_no, warehouse_id, type, status, operator_openid, operator_name, remark, is_deleted, created_at, updated_at)
    VALUES ('OUT-VERIFY-MARK', 1, 'lingyong', 'pending', 'dev_out', '开发·领料员', '[RA]验证标记', 0, NOW(), NOW())`)
  console.log('已造 2 张出库单（KEEP=无标记模拟用户 / MARK=带标记测试数据）\n')

  // ⚠️ stdio 必须 inherit（管道会 EBUSY）
  console.log('── 运行 cleanup --apply ──')
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'cleanup-test-data.js'), '--apply'],
    { stdio: 'inherit' }
  )
  console.log('── cleanup 退出码:', r.status, '──\n')
  check('cleanup 正常退出', r.status === 0, `status=${r.status} err=${r.error && r.error.code}`)

  const keep = await queryOne(`SELECT id FROM outbound_orders WHERE order_no = 'OUT-VERIFY-KEEP'`)
  const markRow = await queryOne(`SELECT id FROM outbound_orders WHERE order_no = 'OUT-VERIFY-MARK'`)

  check('无标记的用户单据（dev_out 做的）被保留', !!keep, '被误删了！')
  check('带标记的测试单据被删除', !markRow, '没被清掉')

  // 恢复现场：删掉保留的那张（它是我的验证数据，不是用户的）
  await execute(`DELETE FROM outbound_orders WHERE order_no = 'OUT-VERIFY-KEEP'`)
  console.log('\n已恢复现场（删掉验证用的 KEEP 单）')
  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
