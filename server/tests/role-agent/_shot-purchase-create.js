/** 一次性截图：后台「发布采购任务」弹窗（分类筛选 + 规格 + 新增物料） */
require('../../src/config/env')
const path = require('path')
const fs = require('fs')
let chromium
try { chromium = require('playwright-core').chromium } catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}
const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const OUT = path.join(process.cwd(), 'tests/role-agent/results/purchase-create')
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) {} })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)
  await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.search-card', { timeout: 8000 })
  await sleep(1200)
  await page.locator('button:has-text("发布采购任务")').first().click()
  await page.waitForSelector('.el-dialog', { timeout: 8000 })
  await sleep(900)
  // 点第一个细分类 chip（跳过「全部」）
  await page.locator('.sub-cat-chip').nth(1).click()
  await sleep(700)
  // 展开物料选择器
  await page.locator('.pick-material-row .el-select').nth(0).click()
  await sleep(1200)
  await page.screenshot({ path: path.join(OUT, '发布采购任务-细分类chips+规格+新增.png') })
  console.log('截图完成：', OUT)
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
