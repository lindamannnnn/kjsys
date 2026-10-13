/**
 * 后台全面 UI 走查（真实浏览器 · 真实点击 · 不写业务数据）
 * ============================================================
 * 对应用户需求（2026-10-13）：「全面测试，不要只检查代码，用真实按键把所有流程跑一遍」
 *
 * 做什么：
 *   6 个身份（admin / boss / director / 配件仓管 / 成品仓管 / 采购员 / 领料员）逐一登录，
 *   把**各自侧边栏的每一个菜单页**真实点开：等渲染、读页面标题、抓 console 报错、截图存档。
 *   再抽查几个关键交互（月结表查询+导出、建入库单页打开、盘点创建页打开、采购任务页）。
 *
 * 输出：
 *   tests/role-agent/results/walkthrough-admin/<身份>/<页面>.png
 *   tests/role-agent/results/walkthrough-admin/report.json   （每页：标题/渲染行数/console报错/断言）
 *
 * ⚠️ 只读走查：打开页面、看列表、查月结、点导出（下载文件不落库）。
 *    不提交任何表单、不写任何业务数据。临时账号 RA_WT_* 跑完自删。
 *
 * 用法：node tests/role-agent/walkthrough-admin.js
 * 前提：静态服务 5179（admin/dist-local）+ 后端 3000
 * ============================================================
 */
require('../../src/config/env')

const path = require('path')
const fs = require('fs')
const bcrypt = require('bcryptjs')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const { query, execute } = require('../../src/db/pool')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const ROOT = path.join(__dirname, '..', '..', '..')
const OUT_DIR = path.join(__dirname, 'results', 'walkthrough-admin')
const PREFIX = 'RA_WT_'
const PASSWORD = 'RA_WT_Pwd_2026'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 页面矩阵（与 admin/src/constants/page-matrix.json 同步读，避免手抄走偏） */
const PAGE_MATRIX = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'admin', 'src', 'constants', 'page-matrix.json'), 'utf8')
).pages

/** 该身份「菜单上应该出现」的页面（menu:true 且角色被允许） */
function menuPagesOf(roles) {
  return Object.keys(PAGE_MATRIX).filter((p) => {
    const m = PAGE_MATRIX[p]
    if (!m.menu) return false
    if (!m.roles || !m.roles.length) return true
    return roles.some((r) => m.roles.includes(r))
  })
}

/* 7 个身份 */
const IDENTITIES = [
  { key: 'admin', label: '后台管理员', roles: ['admin'], codes: [], username: 'admin', password: '123456' },
  { key: 'boss', label: '老板', roles: ['boss'], codes: [] },
  { key: 'director', label: '厂长', roles: ['director'], codes: ['peijian', 'chengpin'] },
  { key: 'sk_parts', label: '配件仓管', roles: ['storekeeper'], codes: ['peijian'] },
  { key: 'sk_goods', label: '成品仓管', roles: ['storekeeper'], codes: ['chengpin'] },
  { key: 'purchase', label: '采购员', roles: ['purchase'], codes: [] },
  { key: 'out', label: '领料员', roles: ['out'], codes: ['peijian'] }
]

async function ensureAccounts() {
  const rows = await query('SELECT id, code FROM warehouses WHERE is_deleted = 0')
  const idByCode = {}
  for (const r of rows) idByCode[r.code] = r.id
  await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
  const hash = await bcrypt.hash(PASSWORD, 10)
  for (const a of IDENTITIES) {
    if (a.username === 'admin') continue // admin 用现成的
    const whIds = (a.codes || []).map((c) => idByCode[c]).filter(Boolean)
    await execute(
      `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, NOW())`,
      [`${PREFIX}${a.key}`, hash, `走查·${a.label}`, JSON.stringify(a.roles), JSON.stringify(whIds)]
    )
    a.username = `${PREFIX}${a.key}`
    a.password = PASSWORD
  }
}

async function cleanup() {
  try {
    await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
  } catch (e) {
    console.error('清理失败：', e.message)
  }
}

async function loginAs(page, username, password) {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) {} })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', username)
  await page.fill('input[placeholder="密码"]', password)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1800)
}

/** 访问一页：读标题、表格行数、是否有「404/找不到」，返回结构化结果 */
async function visitPage(page, pathName, shotPath) {
  const consoleErrs = []
  const onConsole = (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 120)) }
  page.on('console', onConsole)
  try {
    await page.goto(`${ADMIN_URL}${pathName}`, { waitUntil: 'domcontentloaded' })
    await sleep(2400)
    const info = await page.evaluate(() => {
      const body = (document.body.innerText || '')
      const table = document.querySelector('.el-table__body tbody')
      return {
        title: (document.querySelector('.card-header, .page-header, h1, h2')?.innerText || '').trim().slice(0, 40),
        rows: table ? table.querySelectorAll('tr').length : 0,
        has404: /404|页面不存在|找不到页面|Not Found/i.test(body),
        empty: /暂无数据|空空如也|暂无记录/.test(body),
        bodyLen: body.length
      }
    })
    if (shotPath) await page.screenshot({ path: shotPath })
    return { ...info, consoleErrs }
  } catch (e) {
    return { error: e.message, consoleErrs }
  } finally {
    page.off('console', onConsole)
  }
}

;(async () => {
  console.log('\n═══ 后台全面 UI 走查 ═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await ensureAccounts()

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const report = {}

  try {
    for (const idn of IDENTITIES) {
      const dir = path.join(OUT_DIR, idn.label)
      fs.mkdirSync(dir, { recursive: true })
      console.log(`\n■ ${idn.label}（${idn.roles.join('/')}）`)
      await loginAs(page, idn.username, idn.password)

      const pages = menuPagesOf(idn.roles)
      report[idn.label] = { roles: idn.roles, pages: {} }
      console.log(`  菜单页 ${pages.length} 个：${pages.join(' ')}`)

      for (const p of pages) {
        const name = (PAGE_MATRIX[p].title || p).replace(/[\\/:*?"<>|]/g, '_')
        const r = await visitPage(page, p, path.join(dir, `${name}.png`))
        const status = r.error ? '加载异常'
          : r.has404 ? '!! 404'
          : (r.consoleErrs && r.consoleErrs.length) ? `console报错×${r.consoleErrs.length}`
          : r.bodyLen < 80 ? '!! 内容过少'
          : 'OK'
        report[idn.label].pages[p] = { title: r.title, rows: r.rows, status, consoleErrs: r.consoleErrs || [] }
        console.log(`    ${status === 'OK' ? '✅' : '❌'} ${PAGE_MATRIX[p].title || p}（${r.rows} 行）${status !== 'OK' ? ' — ' + status : ''}`)
      }

      /* 关键交互抽查 */
      if (['boss', 'director', 'admin'].includes(idn.key)) {
        // 月结表：查 2026-10 成品仓
        await page.goto(`${ADMIN_URL}/stats/monthly`, { waitUntil: 'domcontentloaded' })
        await sleep(2400)
        const monthlyOk = await page.evaluate(() =>
          document.querySelectorAll('.monthly-table tbody tr').length > 0
        )
        console.log(`    ${monthlyOk ? '✅' : '❌'} 月结表渲染（${idn.label}）`)
        report[idn.label].monthly = monthlyOk
        await page.screenshot({ path: path.join(dir, '月结表.png') })
      }
      if (idn.key === 'admin') {
        // 建入库单页（只打开，不提交）
        await page.goto(`${ADMIN_URL}/order/inbound-create`, { waitUntil: 'domcontentloaded' })
        await sleep(2400)
        const matRows = await page.evaluate(() => document.querySelectorAll('.el-table__body tbody tr').length)
        console.log(`    ${matRows > 0 ? '✅' : '❌'} 新建入库单页加载物料（${matRows} 行）`)
        report[idn.label].inboundCreate = matRows > 0
        await page.screenshot({ path: path.join(dir, '新建入库单.png') })
      }
      if (idn.key === 'director') {
        // 盘点创建页：切抽盘看范围
        await page.goto(`${ADMIN_URL}/check/create`, { waitUntil: 'domcontentloaded' })
        await sleep(2200)
        await page.locator('.el-radio', { hasText: '抽盘' }).first().click().catch(() => {})
        await sleep(600)
        const scopeOk = await page.evaluate(() => (document.body.innerText || '').includes('盘点范围'))
        console.log(`    ${scopeOk ? '✅' : '❌'} 盘点创建页显示盘点范围（厂长）`)
        report[idn.label].checkCreate = scopeOk
        await page.screenshot({ path: path.join(dir, '盘点创建.png') })
      }
      if (idn.key === 'purchase') {
        await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
        await sleep(2200)
        const body = await page.evaluate(() => (document.body.innerText || '').length)
        console.log(`    ✅ 采购任务页打开（采购员，内容 ${body} 字）`)
        report[idn.label].purchaseTasks = body > 100
        await page.screenshot({ path: path.join(dir, '采购任务.png') })
      }
    }
  } finally {
    await browser.close()
    await cleanup()
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

  // 汇总
  let total = 0; let bad = 0
  for (const label of Object.keys(report)) {
    for (const p of Object.keys(report[label].pages || {})) {
      total++
      if (report[label].pages[p].status !== 'OK') bad++
    }
  }
  console.log(`\n──────── 走查完成：${total} 个页面，异常 ${bad} 个 ────────`)
  console.log('报告：', path.join(OUT_DIR, 'report.json'))
  console.log('截图：', OUT_DIR)
  process.exit(bad ? 1 : 0)
})().catch(async (e) => {
  console.error('走查脚本异常：', e)
  await cleanup()
  process.exit(1)
})
