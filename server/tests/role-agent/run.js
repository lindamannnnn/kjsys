/**
 * ============================================================
 * 岗位 Agent 测试命令（role-agent runner）
 * ------------------------------------------------------------
 * 用法：
 *   node tests/role-agent/run.js                    # 跑 3 轮（默认），跑完自动清理测试数据
 *   node tests/role-agent/run.js --rounds 3
 *   node tests/role-agent/run.js --no-cleanup       # 保留现场（排查用），跑完不自动清理
 *
 * 干什么：
 *   6 个岗位 Agent（仓管/领料员/采购员/老板/厂长/后台管理员）各自跑完整流程，
 *   覆盖「小程序侧」（dev_openid 模拟身份）与「后台看板」（adminLogin）两端，
 *   关键断言：
 *     - 权限门（P0）：老板不能造/剥夺/禁用管理员；唯一管理员不可降级
 *     - 数据准确（P1）：库存变动精确到个位数；加权平均成本；金额两位小数
 *     - 两端一致（P1）：老板看板 = 管理员看板；预警四口径一致；库存多角色一致
 *     - 可追溯（P1）：越权留痕、主数据留痕、消息必达
 *   每轮结束做对账（数据库 vs 接口 vs 流水累加）。
 *
 * 输出：
 *   tests/role-agent/results/RA-report-<时间戳>.md / .json
 *   退出码：0 = 全部通过；1 = 有 P0/P1 问题
 * ============================================================
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  callRaw, loginDev, loginAdmin, RoleAgent, FlowAbort, num, db
} = require('./lib')

const sk = require('./roles/storekeeper')
const picker = require('./roles/picker')
const purchaser = require('./roles/purchaser')
const boss = require('./roles/boss')
const admin = require('./roles/admin')
const director = require('./roles/director')
const coverage = require('./roles/coverage')
const mistakes = require('./roles/mistakes')

// ---------------- 参数 ----------------
const args = process.argv.slice(2)
function argOf(name, dft) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dft
}
const ROUNDS = parseInt(argOf('rounds', '3'), 10)
const RUN = Date.now().toString(36)
const OUT_DIR = path.join(__dirname, 'results')

const results = []   // { round, role, label, pass, level, detail }
const alerts = []    // 熔断告警
function alert(msg) { alerts.push(msg); console.error(`\n🚨 ${msg}\n`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 跑一步：FlowAbort 只跳过这一步，不炸掉整轮（断言已记录） */
async function step(label, fn) {
  try {
    await fn()
  } catch (e) {
    if (e instanceof FlowAbort) return false
    results.push({ round: 0, role: 'runner', label: `步骤异常：${label}`, pass: false, level: 'P1', detail: String(e && e.message || e) })
    return false
  }
  return true
}

// ---------------- 主流程 ----------------
async function main() {
  // 健康检查
  const health = await fetch(`${require('./lib').BASE}/api/health`).then((r) => r.status).catch(() => 0)
  if (health !== 200) {
    console.error(`本地服务不可达（health=${health}），请先启动 node src/app.js`)
    process.exit(2)
  }

  // 后台管理员：清掉「首次登录必须改密」门禁（本地测试环境）
  await db.execute("UPDATE users SET must_change_password = 0 WHERE username = ? AND must_change_password = 1",
    [process.env.ADMIN_USERNAME || 'admin']).catch(() => {})
  const adminRow = await db.queryOne('SELECT id FROM users WHERE username = ? LIMIT 1', [process.env.ADMIN_USERNAME || 'admin'])
  if (!adminRow) { console.error('找不到后台管理员账号'); process.exit(2) }
  const adminId = Number(adminRow.id)

  // 登录（每批一次即可，token 有效期内复用）
  const tokens = {
    sk: await loginDev('dev_sk'),
    picker: await loginDev('dev_out'),
    purchaser: await loginDev('dev_purchase'),
    boss: await loginDev('dev_boss'),
    director: await loginDev('dev_director'),
    admin: await loginAdmin(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PASSWORD || '123456')
  }
  console.log('✅ 六个岗位全部登录成功')

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n================ 第 ${round}/${ROUNDS} 轮 ================`)
    const state = {
      round, RUN, adminId,
      mark: `[RA-R${round}]`,
      A: { wid: 1, init: 20, price: 10 },
      B: { wid: 2, init: 20, price: 5 },
      orders: {}, overviews: {},
      baseline: {
        denied: num((await db.queryOne("SELECT COUNT(*) AS c FROM operation_logs WHERE action='permission_denied'")).c),
        materialCreate: num((await db.queryOne("SELECT COUNT(*) AS c FROM operation_logs WHERE action='material_create'")).c)
      }
    }
    const agents = {
      sk: new RoleAgent({ role: '仓管', name: '赵六', token: tokens.sk, round, mark: state.mark, results }),
      picker: new RoleAgent({ role: '领料员', name: '张三', token: tokens.picker, round, mark: state.mark, results }),
      purchaser: new RoleAgent({ role: '采购员', name: '李娜', token: tokens.purchaser, round, mark: state.mark, results }),
      boss: new RoleAgent({ role: '老板', name: '王总', token: tokens.boss, round, mark: state.mark, results }),
      director: new RoleAgent({ role: '厂长', name: '厂长', token: tokens.director, round, mark: state.mark, results }),
      admin: new RoleAgent({ role: '管理员', name: 'admin', token: tokens.admin, round, mark: state.mark, results })
    }
    const helpers = { RUN, db, alert }

    // —— 1. 仓管：建物料 + 入库铺路（含单价回归） ——
    await step('入库铺路', () => sk.inboundSetup(agents.sk, state))

    // —— 2. 领料员：提交出库单（含跨仓权限验证） + 越权探针 ——
    if (state.A.id) await step('提交出库单', () => picker.submitOrders(agents.picker, state))
    await step('领料员越权探针', () => picker.negativeProbes(agents.picker))

    // —— 3. 撤销规则三连（用户定的规则：待拣货可撤，待收货不可撤） ——
    if (state.orders.cp) await step('待确认可撤销', () => picker.cancelPendingProbe(agents.picker, state))
    if (state.orders.cpg) {
      await step('确认cpg', () => sk.confirmOrder(agents.sk, state.orders.cpg, '仓管确认cpg单'))
      await step('待拣货可撤销', () => picker.cancelPickingProbe(agents.picker, state))
    }
    if (state.orders.cr) {
      await step('确认cr', () => sk.confirmOrder(agents.sk, state.orders.cr, '仓管确认cr单'))
      await step('拣货cr', () => sk.pickDone(agents.sk, state.orders.cr, '仓管拣货cr单'))
      await step('待收货不可撤销', () => picker.cancelReceivingProbe(agents.picker, state))
    }

    // —— 4. 主单：仓管确认+拣货 → 领料员收货 ——
    if (state.orders.mainA) {
      await step('确认主单', () => sk.confirmOrder(agents.sk, state.orders.mainA, '仓管确认主单A'))
      await step('拣货主单', () => sk.pickDone(agents.sk, state.orders.mainA, '仓管拣货主单A'))
      await step('收货主单', () => picker.receiveMain(agents.picker, state))
      await step('领料员消息', () => picker.messageCheck(agents.picker, state))
    }

    // —— 4b. wh2 物料B出库闭环（仓管走，领料员只有 wh1 权限） ——
    if (state.B.id) await step('B单出库闭环', () => sk.outboundFullLoopB(agents.sk, state))

    // —— 4c. 领料员误操作包（连点/乱填/超额/重复收货） ——
    if (state.A.id) await step('领料员误操作', () => mistakes.pickerMistakes(agents.picker, state))

    // —— 5. 采购全流程：仓管建单 → 采购员领取录入 → 仓管收料 ——
    if (state.A.id) await step('建采购任务', () => sk.createPurchaseTask(agents.sk, state))
    if (state.purchaseTaskId) {
      await step('采购员录入', () => purchaser.takeAndEntry(agents.purchaser, state))
      await step('采购收料', () => sk.receivePurchase(agents.sk, state))
    }
    await step('采购员越权探针', () => purchaser.negativeProbes(agents.purchaser))
    await step('仓管越权探针', () => sk.negativeProbes(agents.sk))

    // —— 5b. 采购补充：退回重采全流程 + 取消任务 + 重复领取（误操作） ——
    //   2026-10-12：采购任务只针对配件仓（成品不需要采购），全部改用配件仓物料 A
    if (state.A.id) {
      await step('退回重采流程', () => coverage.purchaseExtras(agents, state))
      await step('重复领取探针', async () => {
        const c = await agents.sk.call('purchase', 'create', {
          warehouse_id: state.A.wid, remark: `${state.mark}重复领取`, items: [{ material_id: state.A.id, quantity: 1 }]
        })
        const tid = agents.sk.mustOk('建重复领取任务', c)._id
        await mistakes.takeTwice(agents.purchaser, tid)
        await agents.sk.call('purchase', 'cancel', { id: tid, reason: '探针清理' })
      })
    }

    // —— 5c. 仓管误操作包（重复拣货/入库连点/改价填0/盘点误录/档案改库存） ——
    if (state.A.id) await step('仓管误操作', () => mistakes.storekeeperMistakes(agents.sk, state))

    // —— 5d. 入库补充：改价 + 取消 ——
    if (state.A.id) await step('入库补充', () => coverage.inboundExtras(agents, state))

    // —— 6. 盘点：仓管建单录入 → 老板审核**已收回**（只读）→ 管理员审核 ——
    //   2026-10-09 用户要求「老板那边的审核功能去掉」：审核归 厂长/管理员，
    //   老板侧只验证「点了必须被拒 + 库存不受影响」，审核正例改走管理员，
    //   收件箱做一对正反断言（老板收不到 / 管理员收得到），避免「永远通过的空测试」。
    if (state.A.id) await step('盘点建单提交', () => sk.createAndSubmitCheck(agents.sk, state))
    if (state.checkId) {
      await step('老板审批被拒（只读边界）', () => boss.reviewCheck(agents.boss, state))
      await step('管理员审批盘点', () => admin.reviewCheck(agents.admin, state))
      await step('重复审批被拒', () => mistakes.bossMistakes(agents.admin, state))
      await sleep(500) // 等 fire-and-forget 的待审消息落库
      await step('老板收件箱（不应再收到待审通知）', () => boss.messageCheck(agents.boss, state))
      await step('管理员收件箱（应收到待审通知）', () => admin.messageCheck(agents.admin, state))
    }
    if (state.B.id) await step('盘点取消', () => coverage.checkExtras(agents, state))
    await step('消息已读操作', () => coverage.messageOps(agents))

    // —— 6c. 厂长自主工位（自包含：自建物料、盘点建→提交→取消、发采购单、看两仓） ——
    //   放在盘点段之后，这样 state.checkId 已存在，厂长可验证「能点开别人建的盘点单」
    await step('厂长自主工位', () => director.station(agents, state))
    await step('厂长越权探针', () => director.probes(agents, state))

    // —— 7. 老板：驳回出库 + P0 权限门回归 ——
    if (state.orders.rj) await step('老板驳回出库', () => boss.rejectOutbound(agents.boss, state))
    await step('老板权限门探针', () => boss.adminGuardProbes(agents.boss, state, helpers))
    if (state.A.id) await step('出库补充（撤别人单/仓管驳回/计数）', () => coverage.outboundExtras(agents, state))

    // —— 8. 后台管理员：看板/预警一致性 + 唯一管理员保护 ——
    await step('管理员看板快照', () => admin.loginAndSnapshot(agents.admin, state))
    await step('预警口径一致', () => admin.warningConsistency(agents.admin))
    await step('唯一管理员保护', () => admin.lastAdminProbe(agents.admin, state))
    await step('后台用户管理', () => admin.userManage(agents.admin))

    // —— 8b. 主数据与用户全生命周期 ——
    if (state.A.id) await step('主数据覆盖', () => coverage.masterData(agents, state))
    await step('用户全生命周期', () => coverage.userLifecycle(agents, state, helpers))

    // —— 9. 老板看板快照 + 两端一致性 + 对账 ——
    await step('老板看板快照', () => boss.captureOverview(agents.boss, state))
    await step('统计报表覆盖', () => coverage.statsReports(agents))
    await step('匿名误操作', () => mistakes.anonymousMistakes(results, round))
    await sleep(400) // 等 fire-and-forget 审计日志落库
    await step('审计留痕验证', () => boss.auditVerify(agents.boss, state))
    await reconcile(agents.boss, state)
  }

  writeReport()
}

// ---------------- 对账与两端一致性（runner 级，不属于任何单一岗位） ----------------
async function reconcile(agent, state) {
  const { A, B, mark } = state

  // 两端看板一致（小程序老板视角 vs 后台管理员视角）
  const ovB = state.overviews.boss, ovA = state.overviews.admin
  if (ovB && ovA) {
    for (const f of ['total', 'total_stock', 'total_value', 'warning_count', 'zero_count']) {
      agent.check(`两端看板一致：${f}`, num(ovB[f]) === num(ovA[f]), 'P1',
        `老板 ${ovB[f]} vs 管理员 ${ovA[f]}`)
    }
  }

  // 用数据库做终极对账：账面 = 流水累加 = 接口读数
  for (const M of [A, B]) {
    if (!M.id) continue
    const row = await db.queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [M.id])
    const sumRow = await db.queryOne(
      'SELECT COALESCE(SUM(change_quantity),0) AS s FROM stock_logs WHERE material_id = ?', [M.id])
    const book = num(row.current_stock), flowSum = num(sumRow.s)
    agent.check(`对账(${mark}物料${M.id === A.id ? 'A' : 'B'})：账面=流水累加`,
      Math.abs(book - flowSum) < 0.001, 'P0', `账面 ${book}，流水累加 ${flowSum}`)

    const det = await agent.call('material', 'detail', { id: M.id })
    if (det && det.code === 0) {
      agent.check(`对账(物料${M.id === A.id ? 'A' : 'B'})：接口=数据库`,
        num(det.data.current_stock) === book, 'P1', `接口 ${det.data.current_stock}，数据库 ${book}`)
    }
  }

  // 库存最终值精确核对（流程数学：A=20-3-1+5+1+1-2=21，B=20-2=18）
  //   2026-10-12：采购任务只针对配件仓，「退回重采」从 B 挪到 A → A 多收 1 件（@6），B 少了那 1 件
  if (A.id) {
    const row = await db.queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [A.id])
    agent.check('物料A最终库存=21', num(row.current_stock) === 21, 'P0',
      `实际 ${row.current_stock}（20 +5采购 +1退回重采收料 +1逐项规则收料 -3主单 -1收货探针 -2盘亏）`)
    // 加权均价：出库在前、三笔收料在后 —— 收料时账面是 16（20-3-1）
    // 期望值 = (16×10 + 5×12.5 + 1×6 + 1×7) / 23（存 4 位小数）
    const afterOut = A.init - 3 - 1
    const expAvg = (afterOut * A.price + 5 * 12.5 + 1 * 6 + 1 * 7) / (afterOut + 7)
    agent.check('物料A加权均价正确', Math.abs(num(row.avg_cost) - expAvg) < 0.0001, 'P1',
      `实际 ${row.avg_cost}，期望 ${expAvg.toFixed(4)}（(${afterOut}×${A.price} + 5×12.5 + 1×6 + 1×7)/${afterOut + 7}）`)
  }
  if (B.id) {
    const row = await db.queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [B.id])
    // B 流程数学：20 -2出库 = 18（退回重采已挪到配件仓，B 不再有收料）
    agent.check('物料B最终库存=18', num(row.current_stock) === 18, 'P0', `实际 ${row.current_stock}（20 -2出库，无收料）`)
    const afterOutB = B.init - 2
    const expAvgB = (afterOutB * B.price) / afterOutB
    agent.check('物料B加权均价正确', Math.abs(num(row.avg_cost) - expAvgB) < 0.0001, 'P1',
      `实际 ${row.avg_cost}，期望 ${expAvgB.toFixed(4)}（(${afterOutB}×${B.price})/${afterOutB}，无收料均价不变）`)
  }

  // 本轮单据金额必须两位小数（出库单没有金额列，金额是按明细×均价现算的，只查入库主单+明细）
  const badMoney = await db.query(
    `SELECT order_no, CAST(total_price AS CHAR) AS v FROM inbound_orders WHERE remark LIKE ?
      UNION ALL SELECT o.order_no, CAST(oi.total_price AS CHAR) FROM inbound_order_items oi
        JOIN inbound_orders o ON o.id = oi.order_id WHERE o.remark LIKE ?`,
    [`%${mark}%`, `%${mark}%`])
  const bad = badMoney.filter((r) => {
    const s = String(r.v)
    const i = s.indexOf('.')
    return i >= 0 && s.length - i - 1 > 2
  })
  agent.check('本轮单据金额均为两位小数', bad.length === 0, 'P1',
    bad.length ? bad.map((b) => `${b.order_no}=${b.total_price}`).join(', ') : '')
}

// ---------------- 报告 ----------------
function writeReport() {
  const fails = results.filter((r) => !r.pass)
  const p0 = fails.filter((r) => r.level === 'P0')
  const p1 = fails.filter((r) => r.level === 'P1')
  const p2 = fails.filter((r) => r.level === 'P2')

  const lines = []
  lines.push(`# 岗位 Agent 测试报告（${ROUNDS} 轮 × 6 岗位）`)
  lines.push('')
  lines.push(`- 时间：${new Date().toLocaleString('zh-CN')}`)
  lines.push(`- 断言总数：${results.length}，通过 ${results.length - fails.length}，失败 ${fails.length}`)
  lines.push(`- **P0 ${p0.length} ｜ P1 ${p1.length} ｜ P2 ${p2.length}**`)
  lines.push(`- 结论：**${p0.length + p1.length === 0 ? '干净，可进入下一批' : '有问题，需要修复后重跑'}**`)
  lines.push('')

  // 分岗位统计（让老板一眼看清每个岗位的覆盖与健康状况）
  lines.push('## 分岗位统计')
  lines.push('')
  lines.push('| 岗位 | 断言数 | 通过 | 失败 |')
  lines.push('|---|---|---|---|')
  const byRole = {}
  for (const r of results) {
    if (!byRole[r.role]) byRole[r.role] = { total: 0, fail: 0 }
    byRole[r.role].total++
    if (!r.pass) byRole[r.role].fail++
  }
  for (const role of Object.keys(byRole)) {
    const s = byRole[role]
    lines.push(`| ${role} | ${s.total} | ${s.total - s.fail} | ${s.fail} |`)
  }
  lines.push('')
  if (alerts.length) {
    lines.push('## 🚨 熔断告警（修复失效，已自动恢复现场）')
    alerts.forEach((a) => lines.push(`- ${a}`))
    lines.push('')
  }
  if (fails.length) {
    for (const [level, arr] of [['P0', p0], ['P1', p1], ['P2', p2]]) {
      if (!arr.length) continue
      lines.push(`## ${level}（${arr.length} 条）`)
      arr.forEach((r) => lines.push(`- [R${r.round}][${r.role}] ${r.label}${r.detail ? ` —— ${r.detail}` : ''}`))
      lines.push('')
    }
  } else {
    lines.push('## 全部断言通过 ✅')
  }
  lines.push('## 逐轮概览')
  for (let r = 1; r <= ROUNDS; r++) {
    const rr = results.filter((x) => x.round === r)
    const ff = rr.filter((x) => !x.pass)
    lines.push(`- 第 ${r} 轮：${rr.length} 条断言，失败 ${ff.length}`)
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const mdPath = path.join(OUT_DIR, `RA-report-${stamp}.md`)
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, `RA-report-${stamp}.json`), JSON.stringify({ results, alerts }, null, 2), 'utf8')

  console.log('\n' + lines.slice(0, 8).join('\n'))
  if (fails.length) {
    console.log('\n失败明细：')
    fails.forEach((r) => console.log(`  [${r.level}][R${r.round}][${r.role}] ${r.label} ${r.detail}`))
  }
  console.log(`\n📄 报告：${mdPath}`)

  // ⚠️ 收尾清理（2026-10-09 加）：
  //   本套件会往真实库里写测试物料、单据、库存流水，而且经常拿**真实物料**建单。
  //   不自动清的话，下次打开小程序「库存流水」就是一屏「开发·仓管」（用户 2026-10-09 报的
  //   "老板那边这个页面全是测试数据"就是这么来的）。
  //   清理脚本按 dev_* 账号 + 测试标记识别，不会碰真实数据；--no-cleanup 可跳过。
  if (!process.argv.includes('--no-cleanup')) {
    console.log('\n🧹 收尾：清理本轮测试数据…')
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'cleanup-test-data.js'), '--apply'],
      { stdio: 'inherit' }
    )
    if (r.status !== 0) {
      console.log('⚠️ 清理脚本未正常退出，请手动执行：node tests/cleanup-test-data.js --apply')
    }
  }

  process.exit(p0.length + p1.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('runner 崩溃：', e); process.exit(2) })
