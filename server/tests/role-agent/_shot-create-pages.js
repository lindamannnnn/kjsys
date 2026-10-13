/**
 * 一次性脚本：截两个新页面的图（仓管的新建入库单 / 厂长的成品仓出库）。
 * 用法：node tests/role-agent/_shot-create-pages.js（需先在 5178 起 admin 静态服务）
 */
const path = require('path')
const fs = require('fs')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5178/admin'
const OUT = path.join(process.cwd(), 'tests/role-agent/results/backend-views')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(page, user) {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* 忽略 */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', user)
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1500)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

  // 仓管：新建入库单（加一个物料进清单再截，更接近真实使用）
  await login(page, 'peijian')
  await page.goto(`${ADMIN_URL}/order/inbound-create`, { waitUntil: 'domcontentloaded' })
  await sleep(1800)
  const row = page.locator('.el-table__row').first()
  if (await row.count()) { await row.locator('button', { hasText: '加入' }).click(); await sleep(600) }
  await page.screenshot({ path: path.join(OUT, 'page-新建入库单-仓管.png'), fullPage: true })
  console.log('✅ 新建入库单（仓管视角）已截')

  // 厂长：成品仓出库
  await login(page, 'changzhang')
  await page.goto(`${ADMIN_URL}/order/outbound-create`, { waitUntil: 'domcontentloaded' })
  await sleep(1800)
  const row2 = page.locator('.el-table__row').first()
  if (await row2.count()) { await row2.locator('button', { hasText: '加入' }).click(); await sleep(600) }
  await page.screenshot({ path: path.join(OUT, 'page-成品仓出库-厂长.png'), fullPage: true })
  console.log('✅ 成品仓出库（厂长视角）已截')

  await browser.close()
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
