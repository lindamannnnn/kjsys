/**
 * 诊断：dump 后台 dashboard / message/list 的真实文本，定位「文本过短」与「金额解析」问题。
 */
const path = require('path')
let chromium
try { chromium = require('playwright-core').chromium } catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}
const ADMIN_URL = 'http://127.0.0.1:5178/admin'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)) })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) {} })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'peijian')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1500)

  for (const r of ['/dashboard', '/message/list']) {
    await page.goto(`${ADMIN_URL}${r}`, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    const t = await page.evaluate(() => {
      const main = document.querySelector('.el-main') || document.body
      return (main.innerText || '')
    })
    console.log(`\n===== ${r} =====`)
    console.log(JSON.stringify(t))
    await page.screenshot({ path: path.join(process.cwd(), `tests/role-agent/results/cross-e2e/_diag-${r.replace(/\//g, '_')}.png`) })
  }
  await browser.close()
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
