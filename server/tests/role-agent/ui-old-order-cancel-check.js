/** 一次性验证：用户那张超过 10 分钟的真实单（OUT-20261007-001）现在能撤 */
require('../../src/config/env')
const { loginDev, callRaw, db } = require('./lib')
const { chromium } = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core')

async function main() {
  const row = await db.queryOne(
    "SELECT id, order_no, status, operator_openid, created_at FROM outbound_orders WHERE order_no = 'OUT-20261007-001'")
  console.log('目标单:', JSON.stringify(row))
  if (!row || row.status !== 'pending') { console.log('单据不在待确认状态，换个方式验'); process.exit(0) }

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => {
    try { localStorage.setItem('sl_dev_openid', row.operator_openid); localStorage.removeItem('sl_token') } catch (e) {}
  })
  // 详情页：撤销按钮应出现（超过 10 分钟的单）
  await page.goto('http://127.0.0.1:5174/#/pages/out/detail?id=' + row.id, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  let t = await page.evaluate(() => document.body.innerText)
  console.log('① 老单详情页有撤销按钮 =', t.includes('撤销此单'))

  // 列表页：待确认卡片上有小撤销按钮
  await page.goto('http://127.0.0.1:5174/#/pages/out/history', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.status-tab'))
    const tab = tabs.find((x) => (x.textContent || '').trim() === '待确认')
    if (tab) tab.click()
  })
  await page.waitForTimeout(1500)
  t = await page.evaluate(() => document.body.innerText)
  console.log('② 列表待确认卡片有撤销按钮 =', t.includes('撤销'))

  // 在列表上直接撤掉这张老单（真实闭环验证）
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.btn-cancel-mini'))
    if (btns[0]) btns[0].click()
  })
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    const modal = document.querySelector('.uni-modal')
    if (!modal) return
    const ok = Array.from(modal.querySelectorAll('uni-button, button, div'))
      .find((b) => (b.textContent || '').trim() === '撤销')
    if (ok) ok.click()
  })
  await page.waitForTimeout(2500)
  const det = await callRaw('outbound', 'detail', { id: row.id }, await loginDev(row.operator_openid))
  console.log('③ 撤销后状态 =', det.data.status, '（期望 cancelled）')
  await browser.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
