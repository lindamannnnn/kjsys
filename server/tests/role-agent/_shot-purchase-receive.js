/** 一次性截图：后台「收料入库」逐项登记面板（收到一半的中间态） */
require('../../src/config/env')
const path = require('path')
const fs = require('fs')
let chromium
try { chromium = require('playwright-core').chromium } catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}
const { loginAdmin, loginDev, callRaw } = require('./lib')
const { autoCleanup } = require('./_cleanup')
const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const OUT = path.join(process.cwd(), 'tests/role-agent/results/purchase-receive')
  fs.mkdirSync(OUT, { recursive: true })
  const mark = '[RA-SHOT]'
  const admin = await loginAdmin('admin', '123456')
  const sk = await loginDev('dev_sk_parts')
  const pc = await loginDev('dev_purchase')
  async function ensureMat(name, spec) {
    let r = await callRaw('material', 'upsert', { name, spec, category: '测试类', unit: '个', warehouse_id: 1, remark: mark }, admin)
    if (r.code === 409) {
      const l = await callRaw('material', 'list', { warehouse_id: 1, keyword: name, page: 1, pageSize: 5 }, admin)
      r = { code: 0, data: { _id: (l.data.list.find((m) => m.name === name))._id } }
    }
    return r.data._id
  }
  const mA = await ensureMat(`${mark}KK板`, '30x40')
  const mB = await ensureMat(`${mark}纸箱`, '大号')
  const c = await callRaw('purchase', 'create', { warehouse_id: 1, remark: mark, items: [{ material_id: mA, quantity: 30 }, { material_id: mB, quantity: 50 }] }, sk)
  const tid = c.data._id
  await callRaw('purchase', 'take', { id: tid }, pc)
  await callRaw('purchase', 'entry', { id: tid, items: [{ material_id: mA, unit_price: 12, purchase_channel: '淘宝' }, { material_id: mB, unit_price: 3, purchase_channel: '线下' }] }, pc)

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) {} })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)
  await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.search-card', { timeout: 8000 })
  await sleep(1500)
  const row = page.locator('tr', { hasText: mark + 'KK板' }).first()
  await row.locator('button:has-text("收料入库")').click()
  await page.waitForSelector('.recv-item', { timeout: 8000 })
  await sleep(700)
  // 先收一项（制造中间态）
  await page.locator('.recv-item').nth(0).locator('.el-input-number input').fill('30')
  await page.locator('.recv-item').nth(0).locator('button:has-text("到货入库")').click()
  await page.waitForSelector('.el-message-box', { timeout: 6000 })
  await page.locator('.el-message-box button:has-text("确认")').click()
  await sleep(1600)
  await page.screenshot({ path: path.join(OUT, '收料入库-逐项登记.png') })
  console.log('截图完成')
  await browser.close()
  autoCleanup()
})().catch((e) => { console.error(e); autoCleanup(); process.exit(1) })
