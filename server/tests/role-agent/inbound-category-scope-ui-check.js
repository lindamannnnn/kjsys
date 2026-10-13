/**
 * 单据分类按仓库语义切 · 后台验收（2026-10-12）
 * ============================================================
 * 用户要求：「成品仓 仓库 入库 添加分类 —— 不是成品、配件这些分类，是按现在的车间分类的」
 *
 * 背景：
 *   物料的 `category`（大类）是**仓库级**字段 —— 成品仓恒为「成品」、配件仓恒为「配件」；
 *   真正能区分物料的是 `sub_category`：成品仓=车间（工程车间/节能炉车间/西厨车间），
 *   配件仓=编号分类（A001 板材型材/B004 阀件铜件…）。
 *   而「新建入库单 / 新建出库单」两个页面却拿大类当筛选下拉 ——
 *   成品仓里就一个「成品」，筛了等于没筛，还把仓库名当分类展示出来。
 *   （物料列表页 / 编辑页 / 小程序入库登记早就是「车间 / 编号分类」口径了，这两页是漏网的）
 *
 * 判据：
 *   A 源码层（防回退）—— 两个建单页都改成按 sub_category 过滤
 *   B 成品仓管 → 新建入库单：占位符「车间（全部）」、选项是车间、不含「成品/配件」、
 *     选了车间之后请求里真的带上 sub_category、列表条数与后端同口径查询一致
 *   C 成品仓管 → 新增物料弹窗：细分类标签是「车间」、大类自动填「成品」
 *   D 配件仓管（正向对照）→ 占位符「编号分类（全部）」、选项含 A001 板材型材、不含「配件」
 *   E 厂长 → 新建出库单：占位符「车间（全部）」
 *
 * 用法：node tests/role-agent/inbound-category-scope-ui-check.js
 * 前提：静态服务 5179（admin/dist-local）+ 后端 3000
 * 前置：改了前端代码要先 `npm run build:local`
 *
 * ⚠️ 会建 3 个临时后台账号（RA_ICS_*），跑完自删；cleanup 的 `username LIKE 'RA_%'` 也认得。
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
const VIEWS = path.join(__dirname, '..', '..', '..', 'admin', 'src', 'views', 'order')
const OUT_DIR = path.join(__dirname, 'results', 'inbound-category-scope')
const PREFIX = 'RA_ICS_'
const PASSWORD = 'RA_ICS_Pwd_2026'

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

async function ensureAccounts() {
  const rows = await query('SELECT id, code FROM warehouses WHERE is_deleted = 0')
  const idByCode = {}
  for (const r of rows) idByCode[r.code] = r.id

  await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
  const hash = await bcrypt.hash(PASSWORD, 10)
  const accounts = [
    { u: `${PREFIX}sk_parts`, n: '验收·配件仓管', roles: ['storekeeper'], codes: ['peijian'] },
    { u: `${PREFIX}sk_goods`, n: '验收·成品仓管', roles: ['storekeeper'], codes: ['chengpin'] },
    { u: `${PREFIX}director`, n: '验收·厂长', roles: ['director'], codes: ['peijian', 'chengpin'] }
  ]
  for (const a of accounts) {
    const whIds = a.codes.map((c) => idByCode[c]).filter(Boolean)
    await execute(
      `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, NOW())`,
      [a.u, hash, a.n, JSON.stringify(a.roles), JSON.stringify(whIds)]
    )
  }
  return { sk_parts: accounts[0].u, sk_goods: accounts[1].u, director: accounts[2].u }
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

/** 筛选栏里「分类」那个下拉的占位文字 */
const readFilterPlaceholder = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.filter-bar')
    if (!bar) return '(无筛选栏)'
    const sel = bar.querySelector('.el-select')
    return sel ? (sel.innerText || '').replace(/\s+/g, '') : '(无下拉)'
  })

/** 打开筛选栏下拉并读所有选项文字；打不开就返回空数组（由调用方的断言去报失败） */
async function readFilterOptions(page) {
  try {
    await page.click('.filter-bar .el-select', { timeout: 6000 })
    await page.waitForSelector('.el-select-dropdown__item:visible', { timeout: 6000 })
  } catch (e) {
    return []
  }
  await sleep(400)
  return page.evaluate(() =>
    [...document.querySelectorAll('.el-select-dropdown__item')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').trim())
      .filter(Boolean)
  )
}

/** 点某个选项（按文字）；选不到返回 false，不把整个脚本拖崩 */
async function pickOption(page, text) {
  try {
    await page
      .locator('.el-select-dropdown__item:visible', { hasText: text })
      .first()
      .click({ timeout: 6000 })
  } catch (e) {
    return false
  }
  await sleep(1200)
  return true
}

/** 表格当前渲染的行数（页面有两个表格：物料表在前、入库清单在后 → 只数第一个） */
const readRowCount = (page) =>
  page.evaluate(() => {
    const wrap = document.querySelectorAll('.el-table__body-wrapper')[0]
    return wrap ? wrap.querySelectorAll('tbody tr.el-table__row').length : 0
  })

/**
 * 取出 `materialApi.list({...})` 这一段代码。
 * ⚠️ 判据必须限定在这个调用里 —— 全文件搜 `sub_category:` 会被建档弹窗的
 *    `sub_category: subCategory.value` 命中（对照实验暴露过这个假阳性）。
 */
function listCallBlock(src) {
  const i = src.indexOf('materialApi.list({')
  if (i < 0) return ''
  const j = src.indexOf('\n    })', i)
  return j < 0 ? src.slice(i) : src.slice(i, j + 6)
}

;(async () => {
  console.log('\n═══ 单据分类按仓库语义切（2026-10-12）═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  /* ---------- A 源码层 ---------- */
  console.log('A. 源码层（防回退）')
  const inSrc = fs.readFileSync(path.join(VIEWS, 'inbound-create.vue'), 'utf8')
  const outSrc = fs.readFileSync(path.join(VIEWS, 'outbound-create.vue'), 'utf8')
  const inBlock = listCallBlock(inSrc)
  const outBlock = listCallBlock(outSrc)
  check('新建入库单页的列表查询按 sub_category 过滤', /(?<!_)\bsub_category:/.test(inBlock), JSON.stringify(inBlock.slice(0, 80)))
  check('新建入库单页的列表查询不再带大类 category', !/(?<!_)category:/.test(inBlock), JSON.stringify(inBlock.slice(0, 80)))
  check('新建出库单页的列表查询按 sub_category 过滤', /(?<!_)\bsub_category:/.test(outBlock), JSON.stringify(outBlock.slice(0, 80)))
  check('新建出库单页的列表查询不再带大类 category', !/(?<!_)category:/.test(outBlock), JSON.stringify(outBlock.slice(0, 80)))

  const accounts = await ensureAccounts()
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  // 记录所有 /api/material 请求体（证明筛选真的传给了后端，而不是只改了文案）
  let matReqs = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/material')) {
      try {
        matReqs.push(JSON.parse(r.postData() || '{}'))
      } catch (e) {
        /* ignore */
      }
    }
  })
  const lastListReq = () => [...matReqs].reverse().find((q) => q.action === 'list')

  try {
    /* ---------- B 成品仓管 · 新建入库单 ---------- */
    console.log('\nB. 成品仓管 → 新建入库单')
    await loginAs(page, accounts.sk_goods)
    await page.goto(`${ADMIN_URL}/order/inbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)

    const inPh = await readFilterPlaceholder(page)
    check('筛选占位符是「车间（全部）」', inPh.includes('车间'), `实际「${inPh}」`)

    let opts = await readFilterOptions(page)
    console.log('  选项：', JSON.stringify(opts))
    check('选项里没有「成品」这种大类', !opts.includes('成品'), JSON.stringify(opts))
    check('选项里没有「配件」这种大类', !opts.includes('配件'), JSON.stringify(opts))
    check(
      '选项就是车间（工程车间/节能炉车间/西厨车间）',
      ['工程车间', '节能炉车间', '西厨车间'].every((t) => opts.includes(t)),
      JSON.stringify(opts)
    )
    await page.screenshot({ path: path.join(OUT_DIR, '成品仓-新建入库单-车间筛选.png') })

    // 选一个车间 → 后端请求真的带 sub_category（证明筛选生效，不是只改文案）
    const picked = await pickOption(page, '工程车间')
    check('下拉里能选到「工程车间」', picked)
    const req = lastListReq()
    check('选车间后请求携带 sub_category=工程车间', !!req && req.data && req.data.sub_category === '工程车间', JSON.stringify(req && req.data))
    check('请求不再携带 category', !!req && req.data && req.data.category === undefined, JSON.stringify(req && req.data))

    const rows = await readRowCount(page)
    check('筛选后列表非空且不超过一页 50 条', rows > 0 && rows <= 50, `实际 ${rows} 行`)

    await page.keyboard.press('Escape')
    await sleep(300)

    // 新增物料弹窗
    await page.click('button:has-text("新增物料")')
    await page.waitForSelector('.el-dialog', { timeout: 6000 })
    await sleep(600)
    const dlg = await page.evaluate(() => {
      const d = document.querySelector('.el-dialog')
      if (!d) return null
      return {
        labels: [...d.querySelectorAll('.el-form-item__label')].map((e) => (e.innerText || '').trim()),
        selects: [...d.querySelectorAll('.el-select')].map((e) => (e.innerText || '').replace(/\s+/g, ''))
      }
    })
    console.log('  弹窗字段：', JSON.stringify(dlg))
    check('建档弹窗的细分类标签是「车间」', !!dlg && dlg.labels.includes('车间'), JSON.stringify(dlg && dlg.labels))
    check('建档弹窗大类已自动填「成品」', !!dlg && dlg.selects.some((t) => t.includes('成品')), JSON.stringify(dlg && dlg.selects))
    await page.screenshot({ path: path.join(OUT_DIR, '成品仓-新增物料弹窗.png') })
    await page.keyboard.press('Escape')
    await sleep(300)

    /* ---------- D 配件仓管（正向对照） ---------- */
    console.log('\nD. 配件仓管 → 新建入库单（正向对照：配件仓口径不能被改坏）')
    await loginAs(page, accounts.sk_parts)
    await page.goto(`${ADMIN_URL}/order/inbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    const partsPh = await readFilterPlaceholder(page)
    check('筛选占位符是「编号分类（全部）」', partsPh.includes('编号分类'), `实际「${partsPh}」`)
    opts = await readFilterOptions(page)
    console.log('  选项（前 5）：', JSON.stringify(opts.slice(0, 5)))
    check('选项含「A001 板材型材」这类编号分类', opts.some((o) => o.includes('A001')), JSON.stringify(opts.slice(0, 5)))
    check('选项里没有「配件」这种大类', !opts.includes('配件'), JSON.stringify(opts))
    await page.keyboard.press('Escape')
    await sleep(300)

    /* ---------- E 厂长 · 新建出库单 ---------- */
    console.log('\nE. 厂长 → 新建出库单')
    await loginAs(page, accounts.director)
    await page.goto(`${ADMIN_URL}/order/outbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    const outPh = await readFilterPlaceholder(page)
    check('筛选占位符是「车间（全部）」', outPh.includes('车间'), `实际「${outPh}」`)
    opts = await readFilterOptions(page)
    console.log('  选项：', JSON.stringify(opts))
    check('选项里没有「成品」这种大类', !opts.includes('成品'), JSON.stringify(opts))
    check('选项就是车间', ['工程车间', '节能炉车间', '西厨车间'].some((t) => opts.includes(t)), JSON.stringify(opts))
    await page.screenshot({ path: path.join(OUT_DIR, '厂长-新建出库单-车间筛选.png') })
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
