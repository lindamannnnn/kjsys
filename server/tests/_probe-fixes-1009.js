/**
 * 探针：验证 2026-10-09 修复项（看板周期 / 通知采购 / 盘点审核退回原因）
 * 用法：node tests/_probe-fixes-1009.js
 * 说明：会临时产生 warning_notify 站内消息，脚本结束时自行清理。
 */
const { callRaw, loginDev, db } = require('./role-agent/lib')

const out = []
function log(s) { out.push(s); console.log(s) }

let pass = 0, fail = 0
function check(label, cond, extra = '') {
  if (cond) { pass++; log(`  ✅ ${label}`) } else { fail++; log(`  ❌ ${label} ${extra}`) }
}

async function main() {
  log('=== A. 看板周期（stats.overview period）===')
  const boss = await loginDev('dev_boss')

  const today = await callRaw('stats', 'overview', { period: 'today' }, boss)
  const week = await callRaw('stats', 'overview', { period: 'week' }, boss)
  const month = await callRaw('stats', 'overview', { period: 'month' }, boss)
  const bad = await callRaw('stats', 'overview', { period: 'hacker' }, boss)

  check('period=today 返回 period_label=今天', today.code === 0 && today.data.period_label === '今天', JSON.stringify(today).slice(0, 160))
  check('period=week label=本周', week.code === 0 && week.data.period_label === '本周')
  check('period=month label=本月', month.code === 0 && month.data.period_label === '本月')
  check('非法 period 收敛为今天（不报错）', bad.code === 0 && bad.data.period === 'today', JSON.stringify(bad).slice(0, 160))
  check('today 周期 period_* 与 today_* 数值一致',
    today.data.period_outbound_orders === today.data.today_outbound_orders &&
    today.data.period_inbound_orders === today.data.today_inbound_orders,
    `period_out=${today.data.period_outbound_orders} today_out=${today.data.today_outbound_orders}`)
  check('周期口径是累计：本月出库单数 >= 今天出库单数',
    Number(month.data.period_outbound_orders) >= Number(today.data.period_outbound_orders),
    `month=${month.data.period_outbound_orders} today=${today.data.period_outbound_orders}`)
  check('原有 today_*/pending_* 字段未被破坏（后台大屏依赖）',
    'today_outbound_orders' in today.data && 'pending_checks' in today.data && 'total_value' in today.data)

  log('')
  log('=== A2. 看板周期「做成真的」对照实验 ===')
  log('  （库里现在 0 张单据，三个周期都会是 0，看不出真假 —— 所以造 3 张不同日期的单）')
  const madeOrders = []
  // dev_out 的 warehouse_ids = [1]（配件仓），必须挑配件仓的物料，否则出库提交会被仓库权限拦下
  const mat0 = await db.queryOne(
    'SELECT id, name, unit, warehouse_id, current_stock FROM materials ' +
    'WHERE is_deleted = 0 AND warehouse_id = 1 ORDER BY id LIMIT 1')
  const stockBefore = mat0 ? Number(mat0.current_stock) : null
  const picker0 = await loginDev('dev_out')

  try {
    if (!mat0) { check('找到可用来建单的物料', false); }
    else {
      // 建 3 张出库单，分别落在：今天 / 2 天前 / 5 天前
      //   2026-10-09 是周五 → 本周 = 10-05(一)~10-11(日)
      //   今天(10-09) ∈ 本周 ∈ 本月；2天前(10-07) ∈ 本周；5天前(10-04) 只属于本月（上周日）
      for (const backDays of [0, 2, 5]) {
        const r = await callRaw('outbound', 'submit', {
          items: [{
            material_id: mat0.id,
            material_name: mat0.name,
            quantity: 1,
            unit: mat0.unit
          }],
          type: 'lingyong',
          remark: 'PROBE-1009-PERIOD',
          warehouse_id: mat0.warehouse_id
        }, picker0)
        if (r.code !== 0) { check(`建第 ${backDays} 天前的单`, false, JSON.stringify(r).slice(0, 200)); break }
        const oid = r.data && (r.data.id || r.data._id || r.data.order_id)
        madeOrders.push(oid)
        if (backDays > 0) {
          await db.execute(
            'UPDATE outbound_orders SET created_at = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE id = ?',
            [backDays, oid])
        }
      }
      check('造出 3 张不同日期的出库单', madeOrders.length === 3, `实际 ${madeOrders.length}`)

      const t2 = await callRaw('stats', 'overview', { period: 'today' }, boss)
      const w2 = await callRaw('stats', 'overview', { period: 'week' }, boss)
      const m2 = await callRaw('stats', 'overview', { period: 'month' }, boss)
      log(`  今天=${t2.data.period_outbound_orders} 本周=${w2.data.period_outbound_orders} 本月=${m2.data.period_outbound_orders}`)

      // 这是本组最关键的一条：三个周期必须给出**不同的**数字，
      // 否则「改成真的」就是假的（修复前前端根本没传 period，三个数必然一样）
      check('今天 < 本周 < 本月（周期真的在按时间过滤）',
        Number(t2.data.period_outbound_orders) < Number(w2.data.period_outbound_orders) &&
        Number(w2.data.period_outbound_orders) < Number(m2.data.period_outbound_orders),
        `today=${t2.data.period_outbound_orders} week=${w2.data.period_outbound_orders} month=${m2.data.period_outbound_orders}`)
      check('今天 = 1（只有当天那张算进来）', Number(t2.data.period_outbound_orders) === 1)
      check('本周 = 2（含 2 天前那张）', Number(w2.data.period_outbound_orders) === 2)
      check('本月 = 3（含 5 天前那张）', Number(m2.data.period_outbound_orders) === 3)
    }

    // 越权：领料员能看自己的单，但看板只对 boss/admin/storekeeper/director 开放
    const tDenied = await callRaw('stats', 'overview', { period: 'month' }, picker0)
    check('领料员调看板 overview 仍被拒（403，周期参数没有放宽权限）',
      tDenied.code === 403, `code=${tDenied.code}`)
  } finally {
    if (madeOrders.length) {
      const ph = madeOrders.map(() => '?').join(',')
      await db.execute(`DELETE FROM outbound_order_items WHERE order_id IN (${ph})`, madeOrders)
      await db.execute(`DELETE FROM outbound_orders WHERE id IN (${ph})`, madeOrders)
      await db.execute(`DELETE FROM messages WHERE ref_type='outbound' AND ref_id IN (${ph})`, madeOrders)
      // ⚠️ operation_logs.target_id 是 varchar，传数字会报 Truncated incorrect DOUBLE value
      await db.execute(`DELETE FROM operation_logs WHERE target_id IN (${ph})`, madeOrders.map(String))
      await db.execute(`DELETE FROM stock_logs WHERE related_order_id <> '' AND related_order_type='outbound'
                         AND CAST(related_order_id AS CHAR) IN (${ph})`,
        madeOrders.map(String)).catch(() => {})
    }
    if (mat0 && stockBefore !== null) {
      await db.execute('UPDATE materials SET current_stock = ? WHERE id = ?', [stockBefore, mat0.id])
    }
    log(`  已清理：${madeOrders.length} 张探针单据（含明细/消息/日志），库存回到 ${stockBefore}`)
  }

  log('')
  log('=== B. 通知采购（stats.notifyWarning）===')
  // 库里当前没有预警（库存统一置 10、且没有任何物料有 stock_logs）→ 先造一个可控的预警样本
  //   WARNING_COND 要求：warning_stock>0 且 current_stock<warning_stock 且有 stock_logs 记录
  const mat = await db.queryOne(
    'SELECT id, name, warehouse_id, current_stock, warning_stock FROM materials ' +
    'WHERE is_deleted = 0 AND warning_stock > 0 ORDER BY id LIMIT 1')
  check('找到可用于造预警的物料', !!mat)
  const MARK = 'PROBE-1009-WARN'
  if (!mat) { log('  跳过 B 段'); return finish() }

  await db.execute(
    'INSERT INTO stock_logs (material_id, material_name, warehouse_id, change_type, change_quantity,' +
    ' before_stock, after_stock, related_order_id, related_order_type, operator_openid, operator_name, remark)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [mat.id, mat.name, mat.warehouse_id, 'adjust', 0, mat.current_stock, mat.current_stock, '', '', 'dev_probe', '探针', MARK])
  await db.execute('UPDATE materials SET current_stock = 0 WHERE id = ?', [mat.id])

  try {
    const warn = await callRaw('stats', 'warning', { page: 1, pageSize: 3 }, boss)
    const item = (warn.data && warn.data.list && warn.data.list.find((x) => Number(x._id) === Number(mat.id))) || null
    check('造出的样本出现在预警列表里', !!item, JSON.stringify(warn.data).slice(0, 200))

    const beforeRow = await db.queryOne("SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE type='warning_notify'")
    const maxBefore = Number(beforeRow.m)

    let notifyRes = null
    if (item) {
      notifyRes = await callRaw('stats', 'notifyWarning', { material_id: item._id }, boss)
      log(`  通知结果：code=${notifyRes.code} message=${notifyRes.message}`)
      check('老板单物料通知成功', notifyRes.code === 0, JSON.stringify(notifyRes).slice(0, 220))
      check('返回投递人数 > 0', Number(notifyRes.data && notifyRes.data.notified) > 0,
        JSON.stringify(notifyRes.data))
    }

    const recv = await db.query(
      'SELECT u.openid, u.roles, m.title, m.content, m.ref_type FROM messages m ' +
      'JOIN users u ON u.openid = m.to_openid ' +
      "WHERE m.type='warning_notify' AND m.id > ?", [maxBefore])
    check('站内消息真的落库了（不是假按钮）', recv.length > 0, `新增 ${recv.length} 条`)

    if (recv.length) {
      log(`  样例消息：${recv[0].title} | ${recv[0].content}`)
      check('消息正文带物料名与剩余数量', recv[0].content.includes(mat.name), recv[0].content)
      check('ref_type = warning（前端可据此跳转）', recv[0].ref_type === 'warning', recv[0].ref_type)
      log(`  收件人：${recv.map(r => r.openid + '(' + r.roles + ')').join(', ')}`)
      check('收件人都是 采购员/仓管（无领料员）',
        recv.every(r => /purchase|storekeeper/.test(String(r.roles))),
        JSON.stringify(recv.map(r => r.roles)))
    }
  } finally {
    // 还原现场：库存、流水、消息
    await db.execute('UPDATE materials SET current_stock = ? WHERE id = ?', [mat.current_stock, mat.id])
    await db.execute('DELETE FROM stock_logs WHERE remark = ?', [MARK])
    await db.execute("DELETE FROM messages WHERE type='warning_notify'")
    log(`  已还原：material #${mat.id} 库存回到 ${mat.current_stock}，探针流水与消息已删除`)
  }

  // 越权：领料员不该能通知采购
  const picker = await loginDev('dev_out')
  const denied = await callRaw('stats', 'notifyWarning', {}, picker)
  check('领料员调用被拒（403）', denied.code === 403, `code=${denied.code} msg=${denied.message}`)

  // 厂长有权限（入口在预警页）
  const director = await loginDev('dev_director')
  const dinfo = await callRaw('stats', 'notifyWarning', {}, director)
  log(`  厂长批量通知：code=${dinfo.code} message=${dinfo.message}`)
  check('厂长批量通知被受理（0 或成功，不能 403）', dinfo.code !== 403, `code=${dinfo.code}`)
  await db.execute("DELETE FROM messages WHERE type='warning_notify'")

  log('')
  log('=== C. 盘点审核 remark 落库（check.review 支持 remark）===')
  const checkSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/modules/check.js'), 'utf8')
  check('check.js 的 review 读取 remark', /const remark = String\(data\.remark/.test(checkSrc))
  check('退回分支会把 remark 写进操作日志', /原因：' \+ remark/.test(checkSrc))
  check('退回分支会给盘点人发消息（CHECK_REJECTED）', /MSG_TYPE\.CHECK_REJECTED/.test(checkSrc))

  finish()
}

function finish() {
  log('')
  log('清理：warning_notify 消息已删除')
  log('')
  log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('探针异常：', e); process.exit(2) })
