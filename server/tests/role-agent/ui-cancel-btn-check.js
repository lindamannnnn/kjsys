/** 一次性验证：详情页加载 + 撤销按钮显示（服务器恢复后） */
require('../../src/config/env')
const { loginDev, callRaw } = require('./lib')
const { chromium } = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core')

async function main() {
  // 造一张领料员的待确认单
  const out = await loginDev('dev_out')
  const m = await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, out)
  const mat = m.data.list[0]
  const c = await callRaw('outbound', 'submit', {
    type: 'lingyong', remark: '[RA-UI]撤销按钮验证', items: [{ material_id: mat._id, quantity: 1 }]
  }, out)
  const orderId = c.data._id
  console.log('待确认单就绪:', c.data.order_no)

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 150)))
  await page.addInitScript(() => {
    try { localStorage.setItem('sl_dev_openid', 'dev_out'); localStorage.removeItem('sl_token') } catch (e) {}
  })
  await page.goto('http://127.0.0.1:5174/#/pages/out/detail?id=' + orderId, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  const t = await page.evaluate(() => document.body.innerText)
  console.log('① 详情数据加载 =', t.includes('配件仓') && t.includes(mat.name))
  console.log('② 领料明细非空 =', !t.includes('无明细') && !t.includes('（0 项）'))
  console.log('③ 撤销此单按钮显示 =', t.includes('撤销此单'))

  // 点撤销 → 确认 → 应作废
  if (t.includes('撤销此单')) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('uni-button, button'))
      const b = btns.find((x) => (x.textContent || '').includes('撤销此单'))
      if (b) b.click()
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
    const det = await callRaw('outbound', 'detail', { id: orderId }, out)
    console.log('④ 撤销后状态 =', det.data.status, '（期望 cancelled）')
  }
  await browser.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
