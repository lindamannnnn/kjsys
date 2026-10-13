/**
 * 后台「页面缩小后铺满」验收（2026-10-11）
 * ============================================================
 * 验的是：布局高度是否跟随「实际可见区域」，而不是只认 layout viewport 的 vh。
 *
 * 判据（fillRatio = 容器渲染高 ÷ 窗口高）：
 *   100% 缩放        → ≈1
 *   页面级缩放 25%   → ≈1（修复前只有 0.25）
 *   还原 100%        → ≈1（用户报的「不能自适应回来」）
 *
 * 对照实验（项目铁律）：同一套用例 + 强制 100vh（等价修复前 CSS）→ 必须精确跑红。
 *
 * 用法：node tests/role-agent/zoom-fit-check.js
 * 前提：后台 http://127.0.0.1:5176/admin（dist-local，已含修复）、后端 3000
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

let pass = 0
let fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) } else {
    fail++; failures.push(`${label}${detail ? ' :: ' + detail : ''}`)
    console.log('  ❌', label, detail)
  }
}

/** 被测页面：路由 + 代表容器（取最高的那个作为「整页壳」） */
const ROUTES = [
  { name: '工作台', route: '/dashboard', sel: '.layout-container' },
  { name: '物料列表', route: '/material/list', sel: '.layout-container' },
  { name: '入库单', route: '/order/inbound', sel: '.layout-container' },
  { name: '统计总览', route: '/stats/overview', sel: '.layout-container' },
  { name: '用户管理', route: '/user/list', sel: '.layout-container' },
  { name: '站内信', route: '/message/list', sel: '.layout-container' }
]

/** 侧边栏单独量（position:fixed，最容易暴露 vh 不跟随） */
const SIDEBAR_SEL = '.sidebar'

const measure = ({ sel, sidebarSel }) => {
  const h = window.innerHeight
  const rect = (s) => {
    const el = document.querySelector(s)
    return el ? el.getBoundingClientRect().height : null
  }
  return {
    windowH: h,
    shell: rect(sel),
    sidebar: rect(sidebarSel),
    probeZoom: document.documentElement.style.getPropertyValue('--app-h') || '(未设置)',
    docH: document.documentElement.scrollHeight
  }
}

function ratio(m) {
  if (!m.shell || !m.windowH) return null
  return m.shell / m.windowH
}

;(async () => {
  console.log('\n═══ 后台「缩小后铺满」验收（2026-10-11）═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  // 登录
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })

  // 1. 登录页本身也要铺满（未登录态）
  console.log('1. 登录页')
  {
    const m = await page.evaluate(measure, { sel: '.login-container', sidebarSel: null })
    const r = m.shell / m.windowH
    check('登录页 100% 铺满', r > 0.9, `fillRatio=${r && r.toFixed(3)}`)
    await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[placeholder="用户名"]', 'admin')
    await page.fill('input[placeholder="密码"]', '123456')
    await page.click('.login-btn')
    await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
    await sleep(1500)
  }

  // 2. 各页面：100% → 25% → 还原
  console.log('\n2. 各页面缩放往返')
  for (const item of ROUTES) {
    console.log(`\n  ── ${item.name} (${item.route})`)
    await page.goto(`${ADMIN_URL}${item.route}`, { waitUntil: 'domcontentloaded' })
    await sleep(1600)

    const opts = { sel: item.sel, sidebarSel: SIDEBAR_SEL }
    const base = await page.evaluate(measure, opts)
    check(`${item.name} 100% 铺满`, ratio(base) > 0.9,
      `shell=${base.shell} windowH=${base.windowH} --app-h=${base.probeZoom}`)

    // 缩小到 25%
    await page.evaluate(() => { document.documentElement.style.zoom = '0.25' })
    await sleep(1400)   // 等兜底轮询（800ms）把 --app-h 更新过来
    const z25 = await page.evaluate(measure, opts)
    check(`${item.name} 25% 仍铺满（核心）`, ratio(z25) > 0.9,
      `fillRatio=${ratio(z25) && ratio(z25).toFixed(3)} shell=${z25.shell} windowH=${z25.windowH} --app-h=${z25.probeZoom}`)
    check(`${item.name} 25% 侧边栏铺满`, z25.sidebar && z25.sidebar / z25.windowH > 0.9,
      `sidebar=${z25.sidebar} windowH=${z25.windowH}`)
    await page.screenshot({ path: path.join(OUT_DIR, `25%-${item.name}.png`) })

    // 放大回 100%
    await page.evaluate(() => { document.documentElement.style.zoom = '' })
    await sleep(1400)
    const back = await page.evaluate(measure, opts)
    check(`${item.name} 还原 100% 自适应回来`, ratio(back) > 0.9,
      `fillRatio=${ratio(back) && ratio(back).toFixed(3)}`)
  }

  // 3. 数据大屏（独立 fixed 布局）
  console.log('\n3. 数据大屏')
  {
    const opts = { sel: '.screen-root', sidebarSel: null }
    await page.goto(`${ADMIN_URL}/screen`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    const base = await page.evaluate(measure, opts)
    check('大屏 100% 铺满', ratio(base) > 0.9, `fillRatio=${ratio(base) && ratio(base).toFixed(3)}`)
    await page.evaluate(() => { document.documentElement.style.zoom = '0.25' })
    await sleep(1400)
    const z25 = await page.evaluate(measure, opts)
    check('大屏 25% 仍铺满', ratio(z25) > 0.9, `fillRatio=${ratio(z25) && ratio(z25).toFixed(3)}`)
    await page.screenshot({ path: path.join(OUT_DIR, '25%-数据大屏.png') })
    await page.evaluate(() => { document.documentElement.style.zoom = '' })
  }

  // 4. 对照实验：把 100vh 强行写回去（等价修复前的 CSS）
  console.log('\n4. 对照实验（强制 100vh = 修复前行为，必须跑红）')
  {
    await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(1500)
    await page.addStyleTag({
      content: `.layout-container{min-height:100vh !important} #app{min-height:100vh !important}`
    })
    await page.evaluate(() => { document.documentElement.style.zoom = '0.25' })
    await sleep(1400)
    const m = await page.evaluate(measure, { sel: '.layout-container', sidebarSel: SIDEBAR_SEL })
    const r = ratio(m)
    check('对照：强制 100vh 后 25% 只占约 1/4（证明判据有效）', r !== null && r < 0.5,
      `fillRatio=${r && r.toFixed(3)}（若这里也 ≈1，说明判据无效）`)
    await page.evaluate(() => { document.documentElement.style.zoom = '' })
  }

  console.log(`\n─── 结果：通过 ${pass} / 失败 ${fail} ───`)
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  ·', f)) }
  console.log('截图目录：', OUT_DIR)

  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('验收脚本异常：', e); process.exit(1) })
