/**
 * 采购任务只针对配件仓 · 后台可见性收敛（2026-10-12）
 * ============================================================
 * 用户要求：「成品仓后台不需要采购任务这个功能」
 *
 * 背景：采购任务的作用域本来只有配件仓（成品是车间做的、不需要采购），
 *       但「谁能看哪个页面」原来只按**角色**判 —— 成品仓管也是 storekeeper，
 *       所以侧边栏和看板照样给他看采购任务，点进去只有空列表。
 *
 * 判据：
 *   A 配置层（静态，防回退）
 *     1. page-matrix 的 /order/purchase-tasks 声明 warehouseCode=peijian
 *   B 行为层（真浏览器 + 真后端）
 *     2. 成品仓管 → 菜单里没有「采购任务」
 *     3. 成品仓管 → 看板没有采购状态卡，且**根本没发**采购统计请求（不是藏起来的）
 *     4. 成品仓管 → 手敲 /order/purchase-tasks 被弹回自己的首页
 *     5. 配件仓管（正向对照）→ 菜单有「采购任务」+ 看板有 5 个状态卡
 *     6. 管理员（正向对照）→ 照旧全部可见
 *
 * 用法：node tests/role-agent/purchase-parts-scope-ui-check.js
 * 前提：静态服务 5179（admin/dist-local）+ 后端 3000
 * 前置：改了前端代码要先 `npm run build:local`（后台本地版就是 dist-local）
 *
 * ⚠️ 会建 2 个临时后台账号（RA_PSUI_*，密码 RA_PSUI_Pwd_2026），跑完自删；
 *    cleanup-test-data.js 的 `username LIKE 'RA_%'` 口径也认得。
 * ============================================================
 */
require('../../src/config/env')

const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const { query, execute } = require('../../src/db/pool')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const MATRIX_PATH = path.join(__dirname, '..', '..', '..', 'admin', 'src', 'constants', 'page-matrix.json')
const OUT_DIR = path.join(__dirname, 'results', 'purchase-parts-scope')
const PREFIX = 'RA_PSUI_'
const PASSWORD = 'RA_PSUI_Pwd_2026'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅', label)
  } else {
    fail++
    console.log('  ❌', label, detail)
  }
}

/** 建两个临时后台账号（直连库，中文不乱码） */
async function ensureAccounts() {
  // ⚠️ 库里列名是 id（接口层才映射成 _id）
  const rows = await query('SELECT id, code FROM warehouses WHERE is_deleted = 0')
  const idByCode = {}
  for (const r of rows) idByCode[r.code] = r.id

  await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
  const hash = await bcrypt.hash(PASSWORD, 10)
  const accounts = [
    { username: `${PREFIX}sk_parts`, name: '验收·配件仓管', roles: ['storekeeper'], codes: ['peijian'] },
    { username: `${PREFIX}sk_goods`, name: '验收·成品仓管', roles: ['storekeeper'], codes: ['chengpin'] }
  ]
  for (const a of accounts) {
    const whIds = a.codes.map((c) => idByCode[c]).filter(Boolean)
    await execute(
      `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, NOW())`,
      [a.username, hash, a.name, JSON.stringify(a.roles), JSON.stringify(whIds)]
    )
  }
  return {
    sk_parts: `${PREFIX}sk_parts`,
    sk_goods: `${PREFIX}sk_goods`,
    admin: 'admin'
  }
}

async function cleanup() {
  try {
    await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
    const left = await query(`SELECT COUNT(*) AS c FROM users WHERE username LIKE '${PREFIX}%'`)
    console.log(`\n（已清理临时账号 ${Number(left[0].c) === 0 ? 'OK' : '失败'}）`)
  } catch (e) {
    console.error('清理临时账号失败：', e.message)
  }
}

/** 浏览器登录（每次都清掉上一个账号的 localStorage，避免串号） */
async function loginAs(page, username, password = PASSWORD) {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    try {
      localStorage.clear()
    } catch (e) {
      /* ignore */
    }
  })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', username)
  await page.fill('input[placeholder="密码"]', password)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1600)
}

/** 侧边栏里所有菜单项文字（一级 + 分组内的） */
function readMenuTexts(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.el-menu .el-menu-item, .el-menu .el-sub-menu__title')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ''))
      .filter(Boolean)
  )
}

/** 看板上的采购任务状态卡数量 + 有没有「采购任务」这块标题 */
function readDashboardPurchase(page) {
  return page.evaluate(() => ({
    statCards: document.querySelectorAll('.purchase-stat-item').length,
    labels: [...document.querySelectorAll('.purchase-stat-item .purchase-stat-label')].map((e) =>
      (e.innerText || '').trim()
    ),
    header: [...document.querySelectorAll('.card-header span')].some(
      (e) => (e.innerText || '').trim() === '采购任务'
    )
  }))
}

;(async () => {
  console.log('\n═══ 采购任务只针对配件仓 · 后台可见性收敛（2026-10-12）═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  /* ---------- A 配置层 ---------- */
  console.log('A. 配置层（防回退）')
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'))
  const pt = matrix.pages['/order/purchase-tasks'] || {}
  check('page-matrix 给采购任务声明了 warehouseCode=peijian', pt.warehouseCode === 'peijian', JSON.stringify(pt.warehouseCode))

  const accounts = await ensureAccounts()

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  // 记录看板加载期间发往后端的采购接口请求（用来证明「不是藏起来，是压根没发」）
  let purchaseReqs = []
  page.on('request', (r) => {
    if (r.url().includes('/api/purchase')) purchaseReqs.push(r.url())
  })

  try {
    /* ---------- B-1 成品仓后台 ---------- */
    console.log('\nB-1. 成品仓后台（storekeeper + 只辖成品仓）')
    await loginAs(page, accounts.sk_goods)
    check('登录后落在自己的首页 /dashboard', page.url().includes('/dashboard'), page.url())

    const goodsMenu = await readMenuTexts(page)
    check('侧边栏里没有「采购任务」', !goodsMenu.some((t) => t.includes('采购任务')), JSON.stringify(goodsMenu))
    check('侧边栏里也没有「配件仓物料」（同一套仓库收敛）', !goodsMenu.some((t) => t.includes('配件仓')), JSON.stringify(goodsMenu))
    check('侧边栏里仍有「成品仓物料」（别误伤自己仓）', goodsMenu.some((t) => t.includes('成品仓')), JSON.stringify(goodsMenu))

    purchaseReqs = []
    await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2400)
    const goodsDash = await readDashboardPurchase(page)
    check('看板没有采购任务状态卡', goodsDash.statCards === 0, `实际 ${goodsDash.statCards} 个`)
    check('看板没有「采购任务」标题', !goodsDash.header)
    check('看板**没有发起**任何采购接口请求', purchaseReqs.length === 0, JSON.stringify(purchaseReqs))
    await page.screenshot({ path: path.join(OUT_DIR, '成品仓后台-看板.png'), fullPage: true })

    // 手敲 URL
    await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
    await sleep(1800)
    check('手敲 /order/purchase-tasks 被弹回首页', page.url().includes('/dashboard'), page.url())

    /* ---------- B-2 配件仓后台（正向对照）---------- */
    console.log('\nB-2. 配件仓后台（正向对照：功能不能被一起砍掉）')
    await loginAs(page, accounts.sk_parts)
    const partsMenu = await readMenuTexts(page)
    check('侧边栏有「采购任务」', partsMenu.some((t) => t.includes('采购任务')), JSON.stringify(partsMenu))
    check('侧边栏有「配件仓物料」', partsMenu.some((t) => t.includes('配件仓')), JSON.stringify(partsMenu))

    purchaseReqs = []
    await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2600)
    const partsDash = await readDashboardPurchase(page)
    check('看板有 5 个采购任务状态卡', partsDash.statCards === 5, `实际 ${partsDash.statCards} 个`)
    check(
      '状态卡含 待领取/采购中/待收料/收货中/已入库',
      ['待领取', '采购中', '待收料', '收货中', '已入库'].every((t) => partsDash.labels.includes(t)),
      JSON.stringify(partsDash.labels)
    )
    check('配件仓管**能**发采购接口请求（证明上面那条不是因为接口全挂）', purchaseReqs.length > 0, JSON.stringify(purchaseReqs.length))

    await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
    await sleep(1600)
    check('配件仓管手敲采购任务页不会被弹回', page.url().includes('/order/purchase-tasks'), page.url())

    /* ---------- B-3 管理员（正向对照）---------- */
    console.log('\nB-3. 管理员（正向对照：不隔离的账号照旧全可见）')
    await loginAs(page, accounts.admin, '123456')
    const adminMenu = await readMenuTexts(page)
    check('管理员侧边栏有「采购任务」', adminMenu.some((t) => t.includes('采购任务')), JSON.stringify(adminMenu))
    await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2600)
    const adminDash = await readDashboardPurchase(page)
    check('管理员看板有 5 个采购任务状态卡', adminDash.statCards === 5, `实际 ${adminDash.statCards} 个`)
  } finally {
    await browser.close()
    await cleanup()
  }

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  console.log('截图目录：', OUT_DIR)
  process.exit(fail ? 1 : 0)
})().catch(async (e) => {
  console.error('验收脚本异常：', e)
  await cleanup()
  process.exit(1)
})
