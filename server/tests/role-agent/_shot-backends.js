/**
 * 一次性脚本：分别用三个新后台账号登录，各截一张图。
 * 用法：node tests/role-agent/_shot-backends.js（需先在 5178 起 admin 静态服务）
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
const ACCOUNTS = [
  ['peijian', '配件仓后台'],
  ['chengpin', '成品仓后台'],
  ['changzhang', '厂长后台']
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

  for (const [user, name] of ACCOUNTS) {
    await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* 忽略 */ } })
    await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[placeholder="用户名"]', user)
    await page.fill('input[placeholder="密码"]', '123456')
    await page.click('.login-btn')
    await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
    await sleep(2000)
    const file = path.join(OUT, `${user}-${name}.png`)
    await page.screenshot({ path: file, fullPage: false })
    const logo = await page.evaluate(() =>
      (document.querySelector('.logo, .sidebar-logo, .el-menu') || {}).innerText || '')
    console.log(`✅ ${user}（${name}）落地 ${page.url()} ｜ 截图 ${file}`)
  }
  await browser.close()
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
