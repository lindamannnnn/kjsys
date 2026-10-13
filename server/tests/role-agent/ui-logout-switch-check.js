/** 一次性 UI 验证：开发环境下「退出登录 → 身份选择页 → 一键换岗位」 */
require('../../src/config/env')
const { chromium } = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core')

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)))
  // 以仓管身份进入
  await page.addInitScript(() => {
    try { localStorage.setItem('sl_dev_openid', 'dev_sk'); localStorage.removeItem('sl_token') } catch (e) {}
  })
  await page.goto('http://127.0.0.1:5174/#/pages/index/index', { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)

  // 进「我的」
  await page.goto('http://127.0.0.1:5174/#/pages/my/profile', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)

  // 点退出登录
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('uni-button, button'))
    const t = btns.find((b) => (b.textContent || '').includes('退出登录'))
    if (t) t.click()
  })
  await page.waitForTimeout(800)
  // 确认弹窗
  await page.evaluate(() => {
    const modal = document.querySelector('.uni-modal')
    if (!modal) return
    const btns = Array.from(modal.querySelectorAll('uni-button, button, div'))
    const ok = btns.find((b) => ['确定', '确认'].includes((b.textContent || '').trim()))
    if (ok) ok.click()
  })
  await page.waitForTimeout(2000)

  let t = await page.evaluate(() => document.body.innerText)
  console.log('① 退出后落在身份选择页（登录页+测试账号区） =',
    page.url().includes('login') && t.includes('测试账号'))

  // 一键换「老板」
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.dev-btn'))
    const boss = cards.find((c) => (c.textContent || '').includes('老板'))
    if (boss) boss.click()
  })
  await page.waitForTimeout(3500)
  t = await page.evaluate(() => document.body.innerText)
  console.log('② 一键换老板后落到老板看板 =', t.includes('老板看板') || page.url().includes('boss'))

  // 再退出一次，换「领料员」
  await page.goto('http://127.0.0.1:5174/#/pages/my/profile', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('uni-button, button'))
    const x = btns.find((b) => (b.textContent || '').includes('退出登录'))
    if (x) x.click()
  })
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    const modal = document.querySelector('.uni-modal')
    if (!modal) return
    const ok = Array.from(modal.querySelectorAll('uni-button, button, div'))
      .find((b) => ['确定', '确认'].includes((b.textContent || '').trim()))
    if (ok) ok.click()
  })
  await page.waitForTimeout(2000)
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.dev-btn'))
    const out = cards.find((c) => (c.textContent || '').includes('领料员'))
    if (out) out.click()
  })
  await page.waitForTimeout(3500)
  t = await page.evaluate(() => document.body.innerText)
  console.log('③ 再退出换领料员，落到领料页面 =', t.includes('领料') && (page.url().includes('out') || t.includes('提交领料')))
  await browser.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
