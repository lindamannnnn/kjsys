/**
 * 采购任务：移一级菜单 + 数据看板状态卡 验收（2026-10-12）
 * ============================================================
 * 断言：
 *   ① 侧边栏一级菜单有「采购任务」，且「单据管理」分组里不再有它
 *   ② 数据看板有「采购任务」区，含 5 个状态卡（待领取/采购中/待收料/收货中/已入库）
 *   ③ 点状态卡跳到 /order/purchase-tasks?status=xxx 且列表按该状态筛选
 *
 * 用法：node tests/role-agent/dashboard-purchase-check.js
 * 前提：静态服务 5179（dist-local）+ 后端 3000
 * ============================================================
 */
require('../../src/config/env')
const fs = require('fs')
const path = require('path')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const OUT_DIR = path.join(process.cwd(), 'tests/role-agent/results/dashboard-purchase')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

;(async () => {
  console.log('\n═══ 采购任务：一级菜单 + 看板状态卡 验收（2026-10-12）═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1500)

  // ① 侧边栏：采购任务在一级
  console.log('1. 侧边栏菜单层级')
  const topItems = await page.evaluate(() =>
    [...document.querySelectorAll('.el-menu > .el-menu-item')].map((e) => (e.innerText || '').replace(/\s+/g, '')))
  check('一级菜单含「采购任务」', topItems.includes('采购任务'), `一级项：${JSON.stringify(topItems)}`)
  // 单据管理分组里不该再有采购任务
  const orderGroupText = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.el-menu > .el-sub-menu')]
    const order = groups.find((g) => (g.querySelector('.el-sub-menu__title')?.innerText || '').includes('单据管理'))
    return order ? order.innerText.replace(/\s+/g, '') : '(无单据管理分组)'
  })
  check('「单据管理」分组里不再有「采购任务」', !orderGroupText.includes('采购任务'), `分组内容：${orderGroupText}`)

  // ② 数据看板：采购任务状态区
  console.log('2. 数据看板状态卡')
  await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await sleep(2200)
  const statLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.purchase-stat-item .purchase-stat-label')].map((e) => (e.innerText || '').trim()))
  check('看板有 5 个采购状态卡', statLabels.length === 5, JSON.stringify(statLabels))
  check('状态卡含 待领取/采购中/待收料/收货中/已入库',
    ['待领取', '采购中', '待收料', '收货中', '已入库'].every((t) => statLabels.includes(t)),
    JSON.stringify(statLabels))
  await page.screenshot({ path: path.join(OUT_DIR, '数据看板-采购任务状态.png') })

  // ③ 点状态卡跳转并带筛选
  console.log('3. 状态卡跳转带筛选')
  await page.locator('.purchase-stat-item').nth(0).click()  // 待领取
  await page.waitForFunction(() => location.pathname.includes('/order/purchase-tasks'), null, { timeout: 8000 })
  await sleep(1500)
  const url = page.url()
  check('跳转到采购任务页并带 status=open', url.includes('/order/purchase-tasks') && url.includes('status=open'), `实际 ${url}`)
  // 页面上状态筛选应显示「待领取」被选中（el-select 的回显）
  const statusEcho = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.el-form-item')]
    const st = items.find((i) => (i.innerText || '').includes('状态'))
    return st ? st.innerText.replace(/\s+/g, '') : ''
  })
  check('状态筛选回显「待领取」', statusEcho.includes('待领取'), `实际：${statusEcho}`)

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  console.log('截图目录：', OUT_DIR)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('验收脚本异常：', e); process.exit(1) })
