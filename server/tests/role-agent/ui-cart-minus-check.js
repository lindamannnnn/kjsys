/** 一次性 UI 验证：领料清单数量 1 时点「-」移除该项 */
require('../../src/config/env')
const { chromium } = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core')

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)))
  await page.addInitScript(() => {
    try { localStorage.setItem('sl_dev_openid', 'dev_out'); localStorage.removeItem('sl_token') } catch (e) {}
  })
  await page.goto('http://127.0.0.1:5174/#/pages/out/submit', { waitUntil: 'networkidle' })
  await page.waitForTimeout(4500)

  // 点第一个物料加入清单
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.material-item'))
    if (items[0]) items[0].click()
  })
  await page.waitForTimeout(800)
  let t = await page.evaluate(() => document.body.innerText)
  console.log('① 加入清单 =', t.includes('领料清单 (1 项)') || t.includes('领料清单 (1项)') || /领料清单.*1.*项/.test(t))

  // 数量 1 时点「-」→ 应移除
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.qty-btn'))
    const minus = btns.find((b) => (b.textContent || '').trim() === '-')
    if (minus) minus.click()
  })
  await page.waitForTimeout(800)
  t = await page.evaluate(() => document.body.innerText)
  console.log('② 数量1点-后该项被移除 =', !/领料清单.*1.*项/.test(t) && (t.includes('点下方物料加入') || !t.includes('领料清单 (')))
  console.log('③ 有移除提示 =', t.includes('已移除'))

  // 再加回来，数量 + 到 2，再 - 到 1（不移除），再 - 移除
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.material-item'))
    if (items[0]) items[0].click()
  })
  await page.waitForTimeout(600)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.qty-btn'))
    const plus = btns.find((b) => (b.textContent || '').trim() === '+')
    if (plus) plus.click()
  })
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.qty-btn'))
    const minus = btns.find((b) => (b.textContent || '').trim() === '-')
    if (minus) minus.click()
  })
  await page.waitForTimeout(400)
  t = await page.evaluate(() => document.body.innerText)
  console.log('④ 2→1 时不移除（还在清单） =', /领料清单.*1.*项/.test(t))

  await browser.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
