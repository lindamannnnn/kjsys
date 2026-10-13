/**
 * 后台「发布采购任务」弹窗：分类筛选 + 规格可见 + 就地建档（2026-10-12 用户要求）
 * ============================================================
 * 断言：
 *   ① 弹窗里「采购物料」区有：分类下拉 + 搜索选择器 + 「＋新增物料」按钮
 *   ② 选一个分类 → 物料下拉列出该分类物料，且选项里带规格
 *   ③ 点「＋新增物料」→ 建档弹窗 → 填名称保存 → 物料进入采购清单
 *
 * 用法：node tests/role-agent/purchase-create-form-ui-check.js
 * 前提：静态服务 5179（dist-local）+ 后端 3000
 * 注意：会真实建一个测试物料（[RA-UI] 前缀，跑完 autoCleanup 清掉）
 * ============================================================
 */
require('../../src/config/env')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const { autoCleanup } = require('./_cleanup')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

/** 当前可见的下拉选项文字 */
async function readOptions(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.el-select-dropdown__item')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').trim()).filter(Boolean))
}

;(async () => {
  console.log('\n═══ 后台发布采购任务 · 分类筛选 + 就地建档 验收（2026-10-12）═══\n')

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  // 登录
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', 'admin')
  await page.fill('input[placeholder="密码"]', '123456')
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)

  await page.goto(`${ADMIN_URL}/order/purchase-tasks`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.search-card', { timeout: 8000 })
  await sleep(1200)

  // 打开发布弹窗
  await page.locator('button:has-text("发布采购任务")').first().click()
  await page.waitForSelector('.el-dialog', { timeout: 8000 })
  await sleep(900)

  console.log('1. 弹窗结构')
  const chipCount = await page.locator('.sub-cat-chip').count()
  const hasSearch = await page.locator('.pick-material-row .el-select').nth(0).count()
  const hasAddBtn = await page.locator('.pick-material-row button:has-text("新增物料")').count()
  check('有细分类 chips 条（含「全部」）', chipCount > 0, `chips 数=${chipCount}`)
  check('有「搜索物料」选择器', hasSearch > 0)
  check('有「＋新增物料」按钮', hasAddBtn > 0)

  // 目标仓库默认选中配件仓（只有一个仓）
  const whText = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.el-form-item')]
    const wh = items.find((i) => (i.innerText || '').includes('目标仓库'))
    return wh ? wh.innerText.replace(/\s+/g, '') : ''
  })
  check('目标仓库默认是配件仓', whText.includes('配件'), `实际：${whText}`)

  console.log('2. 细分类 chips → 物料带规格')
  const chipTexts = await page.evaluate(() =>
    [...document.querySelectorAll('.sub-cat-chip')].map((e) => (e.innerText || '').trim()))
  console.log('  chips：', JSON.stringify(chipTexts.slice(0, 6)))
  check('chips 第一个是「全部」', chipTexts[0] === '全部', JSON.stringify(chipTexts[0]))
  // 点第一个具体细分类（跳过「全部」）
  if (chipTexts.length > 1) {
    await page.locator('.sub-cat-chip').nth(1).click()
    await sleep(500)
  }
  // 点物料选择器 → focus 触发加载该分类物料
  await page.locator('.pick-material-row .el-select').nth(0).click()
  await sleep(1200)
  const mats = await readOptions(page)
  console.log('  物料选项示例：', JSON.stringify(mats.slice(0, 3)))
  check('选细分类后物料下拉有内容', mats.length > 0, JSON.stringify(mats))
  check('物料选项带规格（含「|」或「现存」）', mats.some((o) => o.includes('|') || o.includes('现存')), JSON.stringify(mats.slice(0, 3)))

  console.log('3. 就地建档')
  // 关掉物料下拉
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.locator('.pick-material-row button:has-text("新增物料")').click()
  await sleep(700)
  // append-to-body 后嵌套弹窗与外层平级，用标题精确定位
  const matDlg = page.locator('.el-dialog').filter({ has: page.locator('.el-dialog__title', { hasText: '新增物料' }) })
  await matDlg.waitFor({ timeout: 6000 })
  const newName = `[RA-UI]采购建档物料${Date.now() % 100000}`
  await matDlg.locator('input').nth(0).fill(newName)
  await matDlg.locator('input').nth(1).fill('UI-SPEC-01')
  await matDlg.locator('button:has-text("保存并加入清单")').click()
  await sleep(1500)

  const listText = await page.evaluate(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => (d.innerText || '').includes('发布采购任务'))
    return dlg ? dlg.innerText.replace(/\s+/g, '') : ''
  })
  check('新建物料进入采购清单', listText.includes(newName), `清单含 ${newName}？`)

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  await browser.close()
  autoCleanup()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('验收脚本异常：', e); autoCleanup(); process.exit(1) })
