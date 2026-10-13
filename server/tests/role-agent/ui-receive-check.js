/**
 * 一次性 UI 验证：收料清单面板（任务明细预填 / 搜已有加入 / 就地建档 / 确认收料）
 * 用法：node tests/role-agent/ui-receive-check.js
 */
require('../../src/config/env')
const { loginDev, callRaw } = require('./lib')
const { chromium } = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core')

async function main() {
  // —— 用接口造一张「待收料」任务（wh1 配件仓） ——
  const sk = await loginDev('dev_sk')
  const pc = await loginDev('dev_purchase')
  const m = await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, sk)
  const anyMat = m.data.list[0]
  const c = await callRaw('purchase', 'create', {
    warehouse_id: 1, assignee_openid: 'dev_purchase', remark: '[RA-UI]收料面板验证',
    items: [{ material_id: anyMat._id, quantity: 2 }]
  }, sk)
  const tid = c.data._id
  await callRaw('purchase', 'take', { id: tid }, pc)
  await callRaw('purchase', 'entry', {
    id: tid, purchase_channel: '淘宝', items: [{ material_id: anyMat._id, unit_price: 3.5 }]
  }, pc)
  console.log('待收料任务就绪:', tid)

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 150)))
  await page.addInitScript(() => {
    try { localStorage.setItem('sl_dev_openid', 'dev_sk'); localStorage.removeItem('sl_token') } catch (e) {}
  })
  await page.goto('http://127.0.0.1:5174/#/pages/purchase/task-detail?id=' + tid, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)

  await page.click('.action-bar uni-button.btn-primary')
  await page.waitForTimeout(1200)
  let t = await page.evaluate(() => document.body.innerText)
  console.log('① 收料清单打开且预填任务明细 =', t.includes('收料清单') && t.includes(anyMat.name))

  await page.fill('.entry-field input', anyMat.name.slice(0, 4))
  await page.waitForTimeout(1000)
  t = await page.evaluate(() => document.body.innerText)
  console.log('② 搜索出已有物料候选项 =', t.includes('库存'))

  await page.click('text=新增物料对象')
  await page.waitForTimeout(800)
  t = await page.evaluate(() => document.body.innerText)
  console.log('③ 建档面板打开 =', t.includes('新建物料档案'))

  const createCard = page.locator('.card').last()
  const newName = '收料UI新物料X' + Date.now().toString(36).slice(-4)
  await createCard.locator('input').first().fill(newName)
  await createCard.locator('.chip').first().click()
  await createCard.locator('text=创建并加入收料清单').click()
  await page.waitForTimeout(2000)
  t = await page.evaluate(() => document.body.innerText)
  console.log('④ 新物料进入清单（带新物料标记） =', t.includes(newName) && t.includes('新物料'))

  const lastRow = page.locator('.entry-row').last()
  await lastRow.locator('input').nth(0).fill('3')
  await lastRow.locator('input').nth(1).fill('9.9')
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.action-bar uni-button'))
    const target = btns.find((b) => (b.textContent || '').includes('确认收料入库'))
    if (target) target.click()
  })
  await page.waitForTimeout(1000)
  const clicked = await page.evaluate(() => {
    const modal = document.querySelector('.uni-modal') || document.querySelector('[class*=modal]')
    if (!modal) return '无弹窗'
    const btns = Array.from(modal.querySelectorAll('uni-button, button, div'))
    const okBtn = btns.find((b) => (b.textContent || '').trim() === '确认入库')
    if (okBtn) { okBtn.click(); return '点了确认入库' }
    return '没找到按钮: ' + modal.textContent.slice(0, 80)
  })
  console.log('   弹窗确认 =', clicked)
  await page.waitForTimeout(3000)
  t = await page.evaluate(() => document.body.innerText)
  console.log('⑤ 入库成功 =', t.includes('入库成功') || t.includes('已生成入库单') || t.includes('已完成'))
  console.log('页面报错 =', errors.length ? errors.join(' | ') : '无')
  await browser.close()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
