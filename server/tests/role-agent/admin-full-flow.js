/**
 * 后台全流程「真实提交」测试（真实浏览器 · 真实点击 · 写操作）
 * ============================================================
 * 对应用户需求（2026-10-13）：「你可以用模拟数据测试一遍所有功能」
 *
 * 与 walkthrough-admin.js（只读走查）的区别：这个**真实提交表单**，把写操作流程跑通。
 * 覆盖：
 *   1. 建入库单（admin）：选物料加入清单 → 填数量/单价 → 提交 → 库存真的 +N（入库提交即入账）
 *   2. 建出库单（admin）：选物料加入清单 → 填数量 → 提交 → 生成待确认单（不扣库存）
 *   3. 创建盘点（admin）：选成品仓 → 抽盘 → 选车间 → 提交 → 生成盘点单
 *   4. 盘点审核（admin）：接口把盘点提交到待审核 → 后台真实点「审核通过」→ 状态变已完成
 *
 * 安全：所有单据带 `[FULLFLOW]` 标记（盘点单创建弹窗没有备注框 → 建完 SQL 补标）。
 *   跑完自清理（调 cleanup-test-data.js 按流水 delta 回补库存 + 备份）。
 *
 * 用法：node tests/role-agent/admin-full-flow.js
 * 前提：静态服务 5179（admin/dist-local）+ 后端 3000
 * ============================================================
 */
require('../../src/config/env')

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const { query, execute } = require('../../src/db/pool')
const { callRaw, loginAdmin } = require('./lib')
const { assertDestructive } = require('../../src/db/destructive-guard')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const OUT_DIR = path.join(__dirname, 'results', 'admin-full-flow')
const MARK = '[FULLFLOW]'
const W_GOODS = 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}${detail ? `  ← ${detail}` : ''}`) }
}

async function login(page) {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) {} })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1800)
}

/** 物料表格第一行点「加入」进清单 */
async function addFirstMaterial(page) {
  const btn = page.locator('.el-table__body tbody tr').first().locator('button', { hasText: '加入' })
  await btn.click()
  await sleep(800)
}

/** 在清单（第二个表格）里给第一行填数量与单价 */
async function fillCart(page, qty, price) {
  // 清单表格是页面上「入库清单/出库清单」那张；el-input-number 的 input
  const cartTable = page.locator('.el-table').last()
  const numInputs = cartTable.locator('.el-input-number input')
  const cnt = await numInputs.count()
  if (cnt >= 1) await numInputs.nth(0).fill(String(qty))
  if (price !== null && cnt >= 2) await numInputs.nth(1).fill(String(price))
  await sleep(400)
}

async function selfClean() {
  try {
    await execute(`DELETE FROM operation_logs WHERE detail LIKE '%${MARK}%'`)
    const checks = await query(`SELECT id FROM stock_checks WHERE remark LIKE '%${MARK}%'`)
    for (const c of checks) {
      await execute(`DELETE FROM operation_logs WHERE action = 'check_create' AND target_id = ?`, [String(c.id)])
    }
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cleanup-test-data.js'), '--apply'], { stdio: 'inherit' })
    console.log(r.status === 0 ? '（清理完成）' : '⚠️ 清理脚本退出码非 0')
  } catch (e) {
    console.error('自清理异常：', e.message)
  }
}

;(async () => {
  console.log('\n═══ 后台全流程「真实提交」测试 ═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  assertDestructive('后台全流程真实提交测试', '将创建并删除带 [FULLFLOW] 标记的入库/出库/盘点单')

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  const tok = await loginAdmin('admin', '123456')

  try {
    await login(page)

    /* ============ 1. 建入库单 ============ */
    console.log('=== 1. 建入库单（真实提交，库存+N） ===')
    await page.goto(`${ADMIN_URL}/order/inbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(2400)
    const matRows = await page.locator('.el-table__body tbody tr').count()
    ok('物料列表有数据', matRows > 0, `行数 ${matRows}`)
    await addFirstMaterial(page)
    const cartVisible = await page.evaluate(() => (document.body.innerText || '').includes('入库清单（1 项）'))
    ok('物料加入清单（显示「入库清单（1 项）」）', cartVisible)
    await fillCart(page, 5, 2)
    await page.screenshot({ path: path.join(OUT_DIR, '1-建入库单.png') })
    await page.locator('button', { hasText: '提交入库单' }).click()
    await sleep(2800)
    const inLst = await callRaw('inbound', 'list', { page: 1, pageSize: 5 }, tok)
    const inMine = (inLst.data && inLst.data.list || [])[0]
    ok('提交后入库单生成', !!inMine, inMine && inMine.order_no)
    if (inMine) {
      // 标记（后台建单页也没备注框？—— 有。但我们没填；用 SQL 补标便于清理）
      await execute('UPDATE inbound_orders SET remark = ? WHERE id = ?', [MARK, inMine._id])
      const det = await callRaw('inbound', 'detail', { id: inMine._id }, tok)
      const item = det.data && (det.data.items || [])[0]
      ok('入库明细数量=5 单价=2', item && Number(item.quantity) === 5 && Number(item.unit_price) === 2,
        item ? `qty=${item.quantity} price=${item.unit_price}` : '无明细')
      const lg = await query('SELECT before_stock, after_stock, change_quantity FROM stock_logs WHERE material_id=? AND change_type=? ORDER BY id DESC LIMIT 1', [item && item.material_id, 'inbound'])
      const L = lg[0]
      ok('库存流水记录 +5（提交即入账）', !!L && Number(L.change_quantity) === 5 && Number(L.after_stock) === Number(L.before_stock) + 5,
        L ? `before=${L.before_stock} after=${L.after_stock}` : '无流水')
    }

    /* ============ 2. 建出库单 ============ */
    console.log('\n=== 2. 建出库单（真实提交，停在待确认） ===')
    await page.goto(`${ADMIN_URL}/order/outbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(2400)
    // 出库类型是必填项（不选提交按钮一直置灰）：选「领用」
    await page.locator('.el-radio', { hasText: '领用' }).first().click()
    await sleep(500)
    const outRows = await page.locator('.el-table__body tbody tr').count()
    ok('出库页物料列表有数据', outRows > 0, `行数 ${outRows}`)
    await addFirstMaterial(page)
    await fillCart(page, 3, null)
    // 诊断：看 canSubmit 卡在哪（仓库/类型/清单/数量）
    const diag = await page.evaluate(() => {
      const bodyText = document.body.innerText || ''
      const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('提交出库'))
      const radios = [...document.querySelectorAll('.el-radio.is-checked')].map((r) => (r.innerText || '').trim())
      return { hasBtn: !!btn, disabled: btn ? btn.disabled : null, checkedRadios: radios, cartLine: /出库清单（(\d+) 项）/.exec(bodyText)?.[1] }
    })
    console.log('  [诊断]', JSON.stringify(diag))
    await page.screenshot({ path: path.join(OUT_DIR, '2-建出库单.png') })
    await page.locator('button', { hasText: '提交出库' }).click()
    await sleep(2800)
    const outLst = await callRaw('outbound', 'list', { page: 1, pageSize: 5 }, tok)
    const outMine = (outLst.data && outLst.data.list || [])[0]
    ok('提交后出库单生成（待确认，不扣库存）', !!outMine && outMine.status === 'pending', outMine && `${outMine.order_no}/${outMine.status}`)
    if (outMine) await execute('UPDATE outbound_orders SET remark = ? WHERE id = ?', [MARK, outMine._id])

    /* ============ 3. 创建盘点（按车间） ============ */
    console.log('\n=== 3. 创建盘点（成品仓·按车间） ===')
    await page.goto(`${ADMIN_URL}/check/create`, { waitUntil: 'domcontentloaded' })
    await sleep(2400)
    // 选成品仓
    await page.locator('.el-form-item', { hasText: '盘点仓库' }).locator('.el-select').click()
    await sleep(700)
    await page.locator('.el-select-dropdown__item:visible', { hasText: '成品仓' }).first().click()
    await sleep(1200)
    // 切抽盘
    await page.locator('.el-radio', { hasText: '抽盘' }).first().click()
    await sleep(600)
    // 范围选「工程车间」
    await page.locator('.el-form-item', { hasText: '盘点范围' }).locator('.el-select').click()
    await sleep(700)
    await page.locator('.el-select-dropdown__item:visible', { hasText: '工程车间' }).first().click()
    await sleep(500)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: path.join(OUT_DIR, '3-创建盘点.png') })
    await page.locator('button', { hasText: '创建盘点任务' }).click()
    await sleep(2800)
    const ckLst = await callRaw('check', 'list', { page: 1, pageSize: 5 }, tok)
    const ckMine = (ckLst.data && ckLst.data.list || [])[0]
    ok('创建盘点单成功（按工程车间）', !!ckMine, ckMine && ckMine.check_no)
    let checkId = null
    if (ckMine) {
      checkId = ckMine._id
      await execute('UPDATE stock_checks SET remark = ? WHERE id = ?', [MARK, checkId])
      const itemCnt = await query('SELECT COUNT(*) c FROM stock_check_items WHERE check_id=?', [checkId])
      const expect = await query("SELECT COUNT(*) c FROM materials WHERE is_deleted=0 AND warehouse_id=? AND sub_category='工程车间'", [W_GOODS])
      ok(`盘点明细 = 工程车间物料数（${expect[0].c}）`, Number(itemCnt[0].c) === Number(expect[0].c), `实际 ${itemCnt[0].c}`)
    }

    /* ============ 4. 盘点审核（真实点「审核通过」） ============ */
    console.log('\n=== 4. 盘点审核（真实点「审核通过」） ===')
    if (checkId) {
      // 接口把盘点提交到待审核（录入在小程序端，后台无录入页）；提交账面数 = 无差异
      const det = await callRaw('check', 'detail', { id: checkId }, tok)
      const items = (det.data.items || []).map((it) => ({ material_id: it.material_id, actual_stock: Number(it.book_stock) }))
      const subRes = await callRaw('check', 'submit', { id: checkId, items }, tok)
      ok('盘点提交到待审核（接口代录，录入在小程序端）', subRes.code === 0, `code=${subRes.code} ${subRes.message}`)

      // 后台筛选待审核 → 点审核 → 通过
      await page.goto(`${ADMIN_URL}/check/list`, { waitUntil: 'domcontentloaded' })
      await sleep(2200)
      await page.locator('.el-select').first().click()  // 状态筛选
      await sleep(600)
      await page.locator('.el-select-dropdown__item:visible', { hasText: '待审核' }).first().click()
      await sleep(500)
      await page.locator('button', { hasText: '搜索' }).click()
      await sleep(1800)
      const reviewBtn = page.locator('button', { hasText: '审核' }).first()
      const hasReview = await reviewBtn.count()
      ok('待审核列表里有「审核」按钮', hasReview > 0)
      if (hasReview) {
        await reviewBtn.click()
        await sleep(1800)
        await page.screenshot({ path: path.join(OUT_DIR, '4-盘点审核.png') })
        await page.locator('button', { hasText: '审核通过' }).click()
        await sleep(1500)
        // 可能弹确认框
        const confirmBtn = page.locator('.el-message-box button', { hasText: /确定|确认/ })
        if (await confirmBtn.count()) await confirmBtn.first().click()
        await sleep(2200)
        const after = await callRaw('check', 'detail', { id: checkId }, tok)
        ok('审核通过后状态=已完成', after.data && after.data.status === 'completed', `实际 ${after.data && after.data.status}`)
      }
    }
  } catch (e) {
    console.error('流程中断：', e.message)
    ok('流程不中断', false, e.message)
  } finally {
    await browser.close()
    console.log('\n🧹 收尾：自清理…')
    await selfClean()
  }

  console.log(`\n──────── 后台全流程结果：通过 ${pass} / 失败 ${fail} ────────`)
  console.log('截图：', OUT_DIR)
  process.exit(fail ? 1 : 0)
})().catch(async (e) => {
  console.error('套件异常：', e)
  await selfClean()
  process.exit(1)
})
