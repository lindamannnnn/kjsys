/**
 * 一次性探针：看「提交出库」按钮禁用态在 H5 下到底怎么渲染
 * （.btn-submit 是 uni-button 自定义元素，Playwright isDisabled() 对它恒 false）。
 * 用法：H5_URL=http://127.0.0.1:5174 node tests/role-agent/_probe-btn.js
 */
let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}
const H5_URL = process.env.H5_URL || 'http://127.0.0.1:5174'

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => {
    try { localStorage.setItem('sl_dev_openid', 'dev_director'); localStorage.removeItem('sl_token') } catch (e) { /* ignore */ }
  })
  await page.goto(`${H5_URL}/#/pages/out/submit?wh=chengpin`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const m = page.locator('.material-item').first()
  if (await m.count()) { await m.click(); await page.waitForTimeout(1000) }

  const dump = await page.locator('.btn-submit').evaluate((el) => ({
    tag: el.tagName,
    outer: el.outerHTML.slice(0, 400),
    attrDisabled: el.getAttribute('disabled'),
    cls: el.className,
    ariaDisabled: el.getAttribute('aria-disabled')
  }))
  console.log('未选类型时 .btn-submit：')
  console.log('  tag =', dump.tag)
  console.log('  disabled 属性 =', JSON.stringify(dump.attrDisabled))
  console.log('  aria-disabled =', JSON.stringify(dump.ariaDisabled))
  console.log('  class =', dump.cls)
  console.log('  outer =', dump.outer)

  await browser.close()
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
