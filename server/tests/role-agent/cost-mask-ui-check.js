/**
 * 成本价 / 库存价值 列显隐 —— 后台**真浏览器**验收
 * ============================================================
 * 与 cost-mask-check.js 的分工：
 *   cost-mask-check.js  验**后端真防线**（接口里根本没有 avg_cost）
 *   本脚本              验**前端体验层**（表头里真的不出现那两列）
 *
 * 断言：
 *   成品仓管 chengpin  /material/product  → 表头【无】成本价 / 库存价值
 *   配件仓管 peijian   /material/parts    → 表头【无】成本价 / 库存价值
 *   厂长    changzhang /material/product  → 表头【有】成本价 / 库存价值
 *   管理员  admin      /material/list     → 表头【有】成本价 / 库存价值
 *
 * 用法：node tests/role-agent/cost-mask-ui-check.js
 * 前提：后台静态服务已起（默认 http://127.0.0.1:5179/admin）、后端 3000 在跑
 * 产物：tests/role-agent/results/cost-mask/*.png
 * ============================================================
 */
const fs = require('fs')
const path = require('path')
let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const OUT_DIR = path.join(process.cwd(), 'tests/role-agent/results/cost-mask')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅', label)
  } else {
    fail++
    failures.push(`${label}${detail ? ' :: ' + detail : ''}`)
    console.log('  ❌', label, detail)
  }
}

async function adminLogin(page, user, pwd = '123456') {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', user)
  await page.fill('input[placeholder="密码"]', pwd)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)
}

/** 取当前页面 el-table 的表头文字（去重，按出现顺序） */
async function readHeaders(page) {
  return page.evaluate(() => {
    const ths = [...document.querySelectorAll('.el-table__header th, .el-table__header-wrapper th')]
    const names = ths.map((th) => (th.innerText || '').replace(/\s+/g, '')).filter(Boolean)
    return [...new Set(names)]
  })
}

async function openAndRead(page, route, tag) {
  await page.goto(`${ADMIN_URL}${route}`, { waitUntil: 'domcontentloaded' })
  // 等表格真正渲染出来（有表头即算渲染）
  await page.waitForFunction(
    () => !!document.querySelector('.el-table__header th'),
    null,
    { timeout: 15000 }
  ).catch(() => {})
  await sleep(800)
  const heads = await readHeaders(page)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`), fullPage: false })
  return heads
}

async function main() {
  console.log('\n═══ 成本价 / 库存价值 列显隐 · 真浏览器验收 ═══')
  console.log(`后台地址：${ADMIN_URL}\n`)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await ctx.newPage()

  const cases = [
    { user: 'chengpin', route: '/material/product', tag: '成品仓-物料列表', expectCost: false },
    { user: 'peijian', route: '/material/parts', tag: '配件仓-物料列表', expectCost: false },
    { user: 'changzhang', route: '/material/product', tag: '厂长-成品仓物料', expectCost: true },
    { user: 'admin', route: '/material/list', tag: '管理员-物料列表', expectCost: true }
  ]

  for (const c of cases) {
    console.log(`\n[${c.user}] ${c.route}`)
    await adminLogin(page, c.user)
    const heads = await openAndRead(page, c.route, c.tag)
    console.log(`  表头：${heads.join(' | ')}`)

    const hasCost = heads.includes('成本价')
    const hasValue = heads.includes('库存价值')
    const hasStock = heads.includes('当前库存')

    check(`${c.tag} 表格已渲染（表头 >=5 列）`, heads.length >= 5, `实际 ${heads.length} 列`)
    if (c.expectCost) {
      check(`${c.tag} 表头【有】成本价`, hasCost)
      check(`${c.tag} 表头【有】库存价值`, hasValue)
    } else {
      check(`${c.tag} 表头【没有】成本价`, !hasCost)
      check(`${c.tag} 表头【没有】库存价值`, !hasValue)
      // 关键：收的是"钱"，不是把整张表收掉
      check(`${c.tag} 仍然保留「当前库存」列（只收钱不收数量）`, hasStock)
    }
  }

  await browser.close()

  console.log('\n───────────────────────────────')
  console.log(`通过 ${pass} / 共 ${pass + fail}`)
  console.log(`截图：${OUT_DIR}`)
  if (fail) {
    console.log('\n失败项：')
    failures.forEach((f) => console.log('  ·', f))
    process.exitCode = 1
  } else {
    console.log('全部通过 ✅')
  }
}

main().catch((err) => {
  console.error('运行异常：', err && err.message)
  process.exitCode = 1
})
