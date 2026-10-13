/**
 * 后台「收料入库」逐项登记面板 验收（2026-10-12 对齐小程序）
 * ============================================================
 * 流程：造一张待收料任务 → 后台点「收料入库」→ 逐项登记（一项到货入库、一项退货）→ 完成收货
 * 断言：
 *   ① 收料弹窗列出每项明细（数量输入框 + 到货入库 + 退货按钮）
 *   ② 逐项到货后状态变「已到齐」，库存当场加
 *   ③ 退货项状态变「退」
 *   ④ 全部处理完「完成收货」可用 → 办结 → 任务状态 received
 *
 * 用法：node tests/role-agent/purchase-receive-admin-ui-check.js
 * 前提：静态服务 5179（dist-local）+ 后端 3000；会造测试物料/任务，跑完 autoCleanup
 * ============================================================
 */
require('../../src/config/env')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const { loginAdmin, loginDev, callRaw } = require('./lib')
const { queryOne } = require('../../src/db/pool')
const { autoCleanup } = require('./_cleanup')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

const stockOf = async (id) => Number((await queryOne('SELECT current_stock FROM materials WHERE id = ?', [id])).current_stock)

;(async () => {
  console.log('\n═══ 后台收料入库逐项登记 验收（2026-10-12）═══\n')
  const mark = '[RA-RECV]'

  // —— 接口造一张待收料任务（配件仓，2 项） ——
  const admin = await loginAdmin('admin', '123456')
  const sk = await loginDev('dev_sk_parts')
  const pc = await loginDev('dev_purchase')

  async function ensureMat(name, spec) {
    let r = await callRaw('material', 'upsert', { name, spec, category: '测试类', unit: '个', warehouse_id: 1, remark: mark }, admin)
    if (r.code === 409) {
      const list = await callRaw('material', 'list', { warehouse_id: 1, keyword: name, page: 1, pageSize: 5 }, admin)
      r = { code: 0, data: { _id: (list.data.list.find((m) => m.name === name))._id } }
    }
    return r.data._id
  }
  const mA = await ensureMat(`${mark}料A`, 'RECV-A')
  const mB = await ensureMat(`${mark}料B`, 'RECV-B')
  const baseA = await stockOf(mA)
  const baseB = await stockOf(mB)

  const c = await callRaw('purchase', 'create', {
    warehouse_id: 1, remark: mark,
    items: [{ material_id: mA, quantity: 3 }, { material_id: mB, quantity: 5 }]
  }, sk)
  const tid = c.data._id
  await callRaw('purchase', 'take', { id: tid }, pc)
  await callRaw('purchase', 'entry', {
    id: tid, items: [
      { material_id: mA, unit_price: 2, purchase_channel: '淘宝' },
      { material_id: mB, unit_price: 3, purchase_channel: '线下' }
    ]
  }, pc)
  console.log('待收料任务就绪:', tid)

  // —— 后台操作 ——
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)
  await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.search-card', { timeout: 8000 })
  await sleep(1500)

  console.log('1. 收料弹窗结构')
  const row = page.locator('tr', { hasText: mark + '料A' }).first()
  await row.locator('button:has-text("收料入库")').click()
  await page.waitForSelector('.recv-item', { timeout: 8000 })
  await sleep(700)
  const itemCount = await page.locator('.recv-item').count()
  check('收料弹窗列出 2 项明细', itemCount === 2, `实际 ${itemCount}`)
  check('每项有数量输入框 + 到货入库 + 退货',
    await page.locator('.recv-item .el-input-number').count() === 2
    && await page.locator('.recv-item button:has-text("到货入库")').count() === 2
    && await page.locator('.recv-item button:has-text("退货")').count() === 2)
  const finishBtn = () => page.locator('.el-dialog button').filter({ hasText: /完成收货|未到齐/ }).first()
  check('初始「完成收货」不可用（未到齐）', await finishBtn().isDisabled())

  console.log('2. 逐项到货入库（第一项 实到 3）')
  await page.locator('.recv-item').nth(0).locator('.el-input-number input').fill('3')
  await page.locator('.recv-item').nth(0).locator('button:has-text("到货入库")').click()
  await page.waitForSelector('.el-message-box', { timeout: 6000 })
  await page.locator('.el-message-box button:has-text("确认")').click()
  await sleep(1600)
  let txt = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find((x) => (x.innerText || '').includes('收料入库'))
    return d ? d.innerText.replace(/\s+/g, '') : ''
  })
  check('第一项到货后显示「已到齐」', txt.includes('已到齐'), txt.slice(0, 240))
  check('第一项库存当场 +3', (await stockOf(mA)) === baseA + 3, `实际 ${await stockOf(mA)}，期望 ${baseA + 3}`)

  console.log('3. 第二项退货')
  await page.locator('.recv-item').nth(1).locator('button:has-text("退货")').click()
  await page.waitForSelector('.el-message-box', { timeout: 6000 })
  await page.locator('.el-message-box input').fill('破损')
  await page.locator('.el-message-box button:has-text("确认退货")').click()
  await sleep(1600)
  txt = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find((x) => (x.innerText || '').includes('收料入库'))
    return d ? d.innerText.replace(/\s+/g, '') : ''
  })
  check('第二项退货后显示「退」', /✕退/.test(txt), txt.slice(0, 240))
  check('退货不动库存', (await stockOf(mB)) === baseB, `实际 ${await stockOf(mB)}，期望 ${baseB}`)

  console.log('4. 完成收货')
  check('到齐后「完成收货」可用', await finishBtn().isEnabled())
  await finishBtn().click()
  await sleep(1800)
  const taskRow = await queryOne('SELECT status FROM purchase_tasks WHERE id = ?', [tid])
  check('任务办结为 received', taskRow && taskRow.status === 'received', `实际 ${taskRow && taskRow.status}`)

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  await browser.close()
  autoCleanup()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('验收脚本异常：', e); autoCleanup(); process.exit(1) })
