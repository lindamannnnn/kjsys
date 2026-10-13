/**
 * 后台「页面缩小后不铺满」取证探针（2026-10-11）
 * ============================================================
 * 现象：浏览器把页面缩小（25%）后，整个后台只占可视区域顶部一小块，
 *       下方大片空白 —— 布局没有跟着可视区域自适应。
 *
 * 本探针在真浏览器里模拟两种「缩小」：
 *   A. pinch（触控板捏合 / 部分浏览器的页面缩放）  → CDP Emulation.setPageScaleFactor
 *   B. CSS zoom（引擎内部按 zoom 缩放，不改 layout viewport）
 *
 * 每次测量：
 *   innerHeight            layout viewport 高（CSS px）
 *   visualViewport.height  视觉视口高（CSS px）
 *   visualViewport.scale   视觉缩放比
 *   .sidebar / .layout-container 的实际渲染高度
 *   → 判据：容器高度 / 视觉视口高度 < 0.9 即「没铺满」
 *
 * 用法：node tests/role-agent/zoom-fit-probe.js
 * 前提：后台 http://127.0.0.1:5176/admin、后端 3000
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

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5176/admin'
const OUT_DIR = path.join(process.cwd(), 'tests/role-agent/results/zoom-fit')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MEASURE = () => {
  const vv = window.visualViewport
  const q = (s) => document.querySelector(s)
  const rect = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)
  return {
    innerH: window.innerHeight,
    innerW: window.innerWidth,
    vvH: vv ? Math.round(vv.height) : null,
    vvW: vv ? Math.round(vv.width) : null,
    vvScale: vv ? Number(vv.scale.toFixed(3)) : null,
    sidebarH: rect(q('.sidebar')),
    layoutH: rect(q('.layout-container')),
    mainH: rect(q('.main-content')),
    docScrollH: document.documentElement.scrollHeight
  }
}

function show(tag, m) {
  console.log(`\n【${tag}】`)
  console.log(`  innerH=${m.innerH}  visualViewport.height=${m.vvH}  scale=${m.vvScale}`)
  console.log(`  .layout-container 高=${m.layoutH}  .sidebar 高=${m.sidebarH}  .main-content 高=${m.mainH}`)
  const base = m.vvH || m.innerH
  const fill = m.layoutH == null ? null : (m.layoutH / base)
  console.log(`  铺满率 = ${fill == null ? 'n/a' : (fill * 100).toFixed(1) + '%'}  ${fill != null && fill < 0.9 ? '❌ 没铺满' : '✅ 铺满'}`)
  return fill
}

;(async () => {
  console.log('\n═══ 后台「页面缩小不铺满」取证（2026-10-11）═══')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  // 登录
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1500)

  const cdp = await ctx.newCDPSession(page)

  // 基准
  const base0 = await page.evaluate(MEASURE)
  show('基准（100%）', base0)
  await page.screenshot({ path: path.join(OUT_DIR, '0-基准100.png') })

  // A. pinch / 页面缩放 25%
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 0.25 })
  await sleep(800)
  const mA = await page.evaluate(MEASURE)
  show('A. pinch 缩放 25%（CDP setPageScaleFactor）', mA)
  await page.screenshot({ path: path.join(OUT_DIR, 'A-pinch25.png') })
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
  await sleep(500)

  // B. CSS zoom 25%（引擎内部缩放）
  await page.evaluate(() => { document.documentElement.style.zoom = '0.25' })
  await sleep(800)
  const mB = await page.evaluate(MEASURE)
  show('B. CSS zoom 0.25', mB)
  await page.screenshot({ path: path.join(OUT_DIR, 'B-csszoom25.png') })
  await page.evaluate(() => { document.documentElement.style.zoom = '' })

  // C. deviceMetricsOverride scale=0.25（最接近浏览器 zoom level 的模拟）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, scale: 0.25
  })
  await sleep(800)
  const mC = await page.evaluate(MEASURE)
  show('C. deviceMetrics scale=0.25', mC)
  await page.screenshot({ path: path.join(OUT_DIR, 'C-metrics25.png') })
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  console.log('\n产物目录：', OUT_DIR)
  await browser.close()
})().catch((e) => { console.error('探针异常：', e); process.exit(1) })
