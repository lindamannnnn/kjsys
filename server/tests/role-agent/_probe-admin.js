/**
 * 探针：真实浏览器打开后台(5178)，逐账号登录，dump 菜单/路由，验证 playwright 可用。
 * 用法：node tests/role-agent/_probe-admin.js
 */
const path = require('path')
const fs = require('fs')

let chromium
try { chromium = require('playwright-core').chromium } catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5178/admin'
const OUT = path.join(process.cwd(), 'tests/role-agent/results/probe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(page, user, pwd = '123456') {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* 忽略 */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', user)
  await page.fill('input[placeholder="密码"]', pwd)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1500)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

  for (const user of ['peijian', 'chengpin', 'changzhang', 'admin']) {
    try {
      await login(page, user)
      await sleep(1200)
      const info = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.el-menu-item, .el-sub-menu__title')]
          .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
        const identity = (document.querySelector('.page-identity, .logo, .sidebar-logo') || {}).innerText || ''
        return { url: location.href, identity: identity.replace(/\s+/g, ' ').trim(), menu: items }
      })
      console.log(`\n=== ${user} === ${info.url}`)
      console.log('身份:', info.identity)
      console.log('菜单:', JSON.stringify(info.menu, null, 0))
      await page.screenshot({ path: path.join(OUT, `admin-${user}.png`) })
    } catch (e) {
      console.log(`\n=== ${user} === 登录/加载失败: ${e.message}`)
    }
  }

  await browser.close()
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
