/**
 * 成品仓「编号」字段 —— 后台**真浏览器**验收（2026-10-11）
 * ============================================================
 * 与 material-no-check.js 的分工：
 *   material-no-check.js  验**后端**（判重口径 = 名称+规格+编号+仓库）
 *   本脚本                 验**页面展示**（成品仓新增页真的出现编号输入框、列表真的出现编号列）
 *
 * 断言：
 *   成品仓管 /material/product         → 表头含「编号」
 *   成品仓管 /material/edit（选成品仓）→ 出现「编号」标签 + 「不填编号 = 标准产品…」提示
 *   管理员   /material/list            → 表头含「编号」
 *   管理员   /material/edit（配件仓）  → 编号标签照旧（回归保护）
 *
 * ⚠️ 为什么必须先选仓库：edit 页的编号标签/提示由「当前所选仓库」推导，
 *   新增页刚打开时还没选仓库 → 区分不出改动前后。必须选完仓库再断言。
 *
 * 用法：node tests/role-agent/material-no-ui-check.js
 * 前提：后台静态服务 http://127.0.0.1:5179/admin、后端 3000 在跑
 * 产物：tests/role-agent/results/material-no/*.png
 * ============================================================
 */
require('../../src/config/env')
const fs = require('fs')
const path = require('path')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const OUT_DIR = path.join(process.cwd(), 'tests/role-agent/results/material-no')
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

/** 表头文字（去重、去空白） */
async function readHeaders(page) {
  return page.evaluate(() => {
    const ths = [...document.querySelectorAll('.el-table__header th, .el-table__header-wrapper th')]
    return [...new Set(ths.map((th) => (th.innerText || '').replace(/\s+/g, '')).filter(Boolean))]
  })
}

/** 表单里所有 label 文字 */
async function formLabels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.el-form-item__label')].map((e) => (e.innerText || '').trim()).filter(Boolean))
}

/** 页面可见文字（去空白） */
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ''))
}

async function goto(page, route, tag, waitTable = true) {
  await page.goto(`${ADMIN_URL}${route}`, { waitUntil: 'domcontentloaded' })
  if (waitTable) {
    await page.waitForFunction(() => !!document.querySelector('.el-table__header th'), null, { timeout: 15000 }).catch(() => {})
  }
  await sleep(1200)
  if (tag) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) })
  }
}

/** 在「所属仓库」下拉里选第 index 项（该账号有几个仓可选、顺序由后端返回） */
async function selectWarehouse(page, index = 0) {
  await page.click('.el-form-item:has-text("所属仓库") .el-select')
  await page.waitForSelector('.el-select-dropdown__item:visible', { timeout: 6000 })
  await sleep(400)
  await page.locator('.el-select-dropdown__item:visible').nth(index).click()
  await sleep(800)
}

;(async () => {
  console.log('\n═══ 成品仓「编号」字段 · 真浏览器验收（2026-10-11）═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    // ───────── 1. 成品仓管 ─────────
    console.log('1. 成品仓管（chengpin）')
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

    await adminLogin(page, 'chengpin')

    // 1a 成品仓物料列表要有「编号」列
    await goto(page, '/material/product', '成品仓-物料列表')
    const h1 = await readHeaders(page)
    check('成品仓物料列表出现「编号」列', h1.includes('编号'), `表头：${JSON.stringify(h1)}`)

    // 1b 新增页：选成品仓后要有「编号」标签 + 语义提示
    await goto(page, '/material/edit', null, false)
    await selectWarehouse(page, 0)
    let labels = await formLabels(page)
    let txt = await bodyText(page)
    check('【核心】成品仓新增页出现「编号」输入项', labels.includes('编号'), `label：${JSON.stringify(labels)}`)
    check('【核心】成品仓新增页给出语义提示（不填=标准产品 / 填写=已预定）',
      /不填编号=标准产品/.test(txt), '未找到提示文案')
    await page.screenshot({ path: path.join(OUT_DIR, '成品仓-新增物料页.png') })

    // ───────── 2. 管理员 ─────────
    console.log('\n2. 管理员（admin）')
    await adminLogin(page, 'admin')

    // 2a 总物料列表也要有「编号」列
    await goto(page, '/material/list', '管理员-物料列表')
    const h2 = await readHeaders(page)
    check('总物料列表出现「编号」列', h2.includes('编号'), `表头：${JSON.stringify(h2)}`)

    // 2b 配件仓新增页：编号标签照旧（回归保护）
    await goto(page, '/material/edit', null, false)
    await selectWarehouse(page, 0)   // admin 的第一个仓 = 配件仓
    labels = await formLabels(page)
    check('配件仓新增页编号标签照旧存在（回归保护）',
      labels.some((l) => l.includes('编号')), `label：${JSON.stringify(labels)}`)
    await page.screenshot({ path: path.join(OUT_DIR, '配件仓-新增物料页.png') })

    // 2c 成品仓新增页（admin，选第 2 个仓）
    await goto(page, '/material/edit', null, false)
    await selectWarehouse(page, 1)
    txt = await bodyText(page)
    check('管理员在成品仓新增页也能看到编号语义提示（口径统一）',
      /不填编号=标准产品/.test(txt), '未找到提示文案')
    await page.screenshot({ path: path.join(OUT_DIR, '管理员-成品仓新增物料页.png') })

    await page.close()
  } finally {
    await browser.close()
  }

  console.log(`\n──────── 结果：${pass}/${pass + fail} 通过，失败 ${fail} ────────`)
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail ? 1 : 0)
})()
