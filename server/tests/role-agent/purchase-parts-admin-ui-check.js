/**
 * 采购任务只针对配件仓 · 后台采购页验收（2026-10-12）
 * ============================================================
 * 断言：后台「采购任务」页的仓库筛选下拉 + 新建表单的「采购到哪个仓」下拉，
 *       都只剩配件仓（无成品仓）。
 *
 * 用法：node tests/role-agent/purchase-parts-admin-ui-check.js
 * 前提：静态服务 5179（dist-local）+ 后端 3000
 * ============================================================
 */
require('../../src/config/env')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

;(async () => {
  console.log('\n═══ 后台采购页 · 仓库只剩配件仓（2026-10-12）═══\n')

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  // 登录
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)

  await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
  await sleep(1800)
  await page.waitForSelector('.search-card', { timeout: 8000 })

  /** 读当前打开的下拉选项文字 */
  async function readDropdownOptions() {
    return page.evaluate(() =>
      [...document.querySelectorAll('.el-select-dropdown__item')].map((e) => (e.innerText || '').trim()).filter(Boolean))
  }

  // 1. 搜索筛选的仓库下拉
  console.log('1. 搜索筛选的仓库下拉')
  await page.click('.el-select')  // 第一个 el-select 是仓库筛选
  await page.waitForSelector('.el-select-dropdown__item:visible', { timeout: 6000 })
  await sleep(400)
  let opts = await readDropdownOptions()
  console.log('  选项：', JSON.stringify(opts))
  check('筛选下拉无「成品仓」', !opts.some((o) => o.includes('成品')), JSON.stringify(opts))
  check('筛选下拉含「配件仓」', opts.some((o) => o.includes('配件')), JSON.stringify(opts))
  await page.keyboard.press('Escape')
  await sleep(400)

  // 2. 新建采购任务表单的仓库下拉
  console.log('2. 新建表单的「采购到哪个仓」下拉')
  // 打开新建弹窗（按钮文案含「新建」或「发布」）
  const btn = page.locator('button:has-text("新建"), button:has-text("发布"), button:has-text("采购")').first()
  await btn.click()
  await sleep(900)
  // 表单里的仓库下拉
  await page.click('.el-dialog .el-select, .el-drawer .el-select')
  await page.waitForSelector('.el-select-dropdown__item:visible', { timeout: 6000 })
  await sleep(400)
  opts = await readDropdownOptions()
  console.log('  选项：', JSON.stringify(opts))
  check('新建下拉无「成品仓」', !opts.some((o) => o.includes('成品')), JSON.stringify(opts))
  check('新建下拉含「配件仓」', opts.some((o) => o.includes('配件')), JSON.stringify(opts))

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('验收脚本异常：', e); process.exit(1) })
