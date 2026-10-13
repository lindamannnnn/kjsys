/**
 * 盘点范围按仓库语义切 · 验收（2026-10-12）
 * ============================================================
 * 用户要求：「要改」（承接入库/出库建单页的分类口径问题，把盘点范围一并修）
 *
 * 背景：
 *   「创建盘点任务」的**盘点范围**原来按 `category`（大类）多选。
 *   但大类是**仓库级**字段 —— 成品仓恒为「成品」、配件仓恒为「配件」，
 *   一个仓永远只有一个值 → 勾不勾都等于整仓盘，「按车间盘」这个能力根本不存在。
 *   真正的维度是 `sub_category`：成品仓=车间（工程/节能炉/西厨），
 *   配件仓=编号分类（A001 板材型材…）。
 *
 * 判据：
 *   A 源码层（防回退）—— 后端 where 支持 sub_category、两端建单/列表页改用它
 *   B 后端接口层（真实建单）
 *     · 成品仓按「工程车间」盘 → 明细条数 = 该车间物料数，且明细全部属于该车间
 *     · 配件仓按「A001 板材型材」盘 → 同上（配件仓同样是「一个值＝没得筛」）
 *     · 全盘守卫不能被误伤：选了细分类但没带 confirm_full_scan，配件仓（>200 项）也必须放行
 *     · 全盘守卫仍生效：不带任何范围、不带 confirm → 拒绝
 *   C 成品仓管 → 创建盘点页：切「抽盘」后范围为「车间」，选项=3 个车间、不含「成品」
 *   D 成品仓管 → 盘点列表：「盘点范围」列显示「车间: 工程车间」（不是「分类: 成品」）
 *   E 配件仓管（正向对照）→ 范围为「编号分类」，选项含 A001 板材型材
 *
 * 用法：node tests/role-agent/check-scope-ui-check.js
 * 前提：静态服务 5179（admin/dist-local）+ 后端 3000
 * 前置：改了前端要先重建 admin/dist-local
 *
 * ⚠️ 会在真实库建 2 张盘点单（带 RA_CKSCOPE 标记），**跑完自删**（连同明细与操作日志）；
 *    临时后台账号 RA_CKSCOPE_* 也自删。
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
const { callRaw, loginAdmin } = require('./lib')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const ROOT = path.join(__dirname, '..', '..', '..')
const OUT_DIR = path.join(__dirname, 'results', 'check-scope')
const PREFIX = 'RA_CKSCOPE_'
const MARK = 'RA_CKSCOPE'
const PASSWORD = 'RA_CKSCOPE_Pwd_2026'

const W2 = 2 // 成品仓
const W1 = 1 // 配件仓

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

/** 本脚本建出来的盘点单 id —— 用于精确清理 */
const createdChecks = []

async function ensureAccounts() {
  const rows = await query('SELECT id, code FROM warehouses WHERE is_deleted = 0')
  const idByCode = {}
  for (const r of rows) idByCode[r.code] = r.id

  await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
  const hash = await bcrypt.hash(PASSWORD, 10)
  const accounts = [
    { u: `${PREFIX}sk_parts`, n: '验收·配件仓管', roles: ['storekeeper'], codes: ['peijian'] },
    { u: `${PREFIX}sk_goods`, n: '验收·成品仓管', roles: ['storekeeper'], codes: ['chengpin'] }
  ]
  for (const a of accounts) {
    const whIds = a.codes.map((c) => idByCode[c]).filter(Boolean)
    await execute(
      `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, NOW())`,
      [a.u, hash, a.n, JSON.stringify(a.roles), JSON.stringify(whIds)]
    )
  }
  return { sk_parts: accounts[0].u, sk_goods: accounts[1].u }
}

async function cleanup() {
  try {
    if (createdChecks.length) {
      const ph = createdChecks.map(() => '?').join(',')
      await execute(`DELETE FROM stock_check_items WHERE check_id IN (${ph})`, createdChecks)
      const opRes = await execute(
        `DELETE FROM operation_logs WHERE action = 'check_create' AND target_id IN (${ph})`,
        createdChecks
      )
      const r = await execute(`DELETE FROM stock_checks WHERE id IN (${ph})`, createdChecks)
      console.log(`（已删盘点单 ${r.affectedRows} 张 / 操作日志 ${opRes.affectedRows} 条）`)
      createdChecks.length = 0
    }
    // 兜底：万一某张单没能记进 createdChecks（例如接口异常但已落库），按标记再扫一遍
    const stray = await query(`SELECT id FROM stock_checks WHERE remark LIKE '${MARK}%'`)
    if (stray.length) {
      const ids = stray.map((r) => r.id)
      const ph = ids.map(() => '?').join(',')
      await execute(`DELETE FROM stock_check_items WHERE check_id IN (${ph})`, ids)
      await execute(`DELETE FROM operation_logs WHERE action = 'check_create' AND target_id IN (${ph})`, ids)
      await execute(`DELETE FROM stock_checks WHERE id IN (${ph})`, ids)
      console.log(`（兜底清掉 ${ids.length} 张带标记的残留单）`)
    }
    await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)

    const leftAcc = await query(`SELECT COUNT(*) AS c FROM users WHERE username LIKE '${PREFIX}%'`)
    const leftChk = await query(`SELECT COUNT(*) AS c FROM stock_checks WHERE remark LIKE '${MARK}%'`)
    console.log(`\n（清理结果：临时账号 ${leftAcc[0].c} / 带标记盘点单 ${leftChk[0].c} —— 都应为 0）`)
  } catch (e) {
    console.error('清理失败：', e.message)
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

/** 切到「抽盘」（否则范围这一栏不显示） */
async function pickSampleType(page) {
  try {
    await page.locator('.el-radio', { hasText: '抽盘' }).first().click({ timeout: 6000 })
  } catch (e) {
    return false
  }
  await sleep(600)
  return true
}

/** 读出「盘点范围」那一栏下拉的显示文字（未选时为占位符） */
const readScopeSelectText = (page) =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.el-form-item')]
    const fi = items.find((x) => ((x.querySelector('.el-form-item__label') || {}).innerText || '').includes('盘点范围'))
    if (!fi) return '(找不到盘点范围这一栏)'
    const sel = fi.querySelector('.el-select')
    return sel ? (sel.innerText || '').replace(/\s+/g, '') : '(没有下拉)'
  })

/** 读出这一栏下面的提示文字 */
const readScopeTip = (page) =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.el-form-item')]
    const fi = items.find((x) => ((x.querySelector('.el-form-item__label') || {}).innerText || '').includes('盘点范围'))
    const tip = fi && fi.querySelector('.tip')
    return tip ? (tip.innerText || '').replace(/\s+/g, '') : ''
  })

/** 打开盘点范围下拉并读选项 */
async function readScopeOptions(page) {
  const opened = await page
    .evaluate(() => {
      const items = [...document.querySelectorAll('.el-form-item')]
      const fi = items.find((x) => ((x.querySelector('.el-form-item__label') || {}).innerText || '').includes('盘点范围'))
      const sel = fi && fi.querySelector('.el-select')
      if (!sel) return false
      sel.querySelector('input')?.click()
      return true
    })
    .catch(() => false)
  if (!opened) return []
  await sleep(700)
  return page.evaluate(() =>
    [...document.querySelectorAll('.el-select-dropdown__item')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').trim())
      .filter(Boolean)
  )
}

/** 某仓库某细分类下的物料数（后端同口径） */
async function countBySub(warehouseId, sub) {
  const r = await query(
    'SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND warehouse_id = ? AND sub_category = ?',
    [warehouseId, sub]
  )
  return Number(r[0].c)
}

/** 校验：某张盘点单的明细是否「全部且仅」来自指定细分类 */
async function auditItems(checkId, warehouseId, sub) {
  const rows = await query(
    `SELECT i.material_id, m.sub_category AS sub
       FROM stock_check_items i
       JOIN materials m ON m.id = i.material_id
      WHERE i.check_id = ?`,
    [checkId]
  )
  const total = rows.length
  const wrong = rows.filter((r) => r.sub !== sub)
  return { total, wrong: wrong.length, sample: wrong.slice(0, 3).map((r) => r.sub) }
}

;(async () => {
  console.log('\n═══ 盘点范围按仓库语义切（2026-10-12）═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  /* ---------- A 源码层 ---------- */
  console.log('A. 源码层（防回退）')
  const checkMod = fs.readFileSync(path.join(ROOT, 'server', 'src', 'modules', 'check.js'), 'utf8')
  check('后端 check.create 支持按 sub_category 过滤', /sub_category\s+IN\s*\(/.test(checkMod))
  check('后端全盘守卫把 sub_categories 算作已选范围', /!subCategories\.length/.test(checkMod))

  const createSrc = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'views', 'check', 'create.vue'), 'utf8')
  check('后台建盘点页的范围下拉用细分类选项', /v-for="c in subCategories"/.test(createSrc))
  check('后台建盘点页提交 scope.sub_categories', /sub_categories:\s*form\.value\.subCategories/.test(createSrc))
  check('后台建盘点页不再把大类当范围提交', !/categories:\s*form\.value\.categories/.test(createSrc))
  check('后台建盘点页按仓库给出范围栏名称（车间/编号分类）', /'车间'/.test(createSrc) && /'编号分类'/.test(createSrc))

  const listSrc = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'views', 'check', 'list.vue'), 'utf8')
  check('后台盘点列表范围文案支持 sub_categories', /scope\.sub_categories/.test(listSrc))

  const mpSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'src', 'pages', 'check', 'list.vue'), 'utf8')
  check('小程序盘点列表范围文案支持 sub_categories', /scope\.sub_categories/.test(mpSrc))

  /* ---------- 准备账号 ---------- */
  const accounts = await ensureAccounts()
  const tokGoods = await loginAdmin(accounts.sk_goods, PASSWORD)
  const tokParts = await loginAdmin(accounts.sk_parts, PASSWORD)

  const nGongcheng = await countBySub(W2, '工程车间')
  const nA001 = await countBySub(W1, 'A001 板材型材')
  console.log(`  基线：成品仓「工程车间」${nGongcheng} 项；配件仓「A001 板材型材」${nA001} 项`)

  /* ---------- B 后端接口层 ---------- */
  console.log('\nB. 后端接口层（真实建单 → 明细核对）')

  const rGoods = await callRaw(
    'check',
    'create',
    {
      type: 'sample',
      warehouse_id: W2,
      scope: { categories: [], sub_categories: ['工程车间'], material_ids: [] },
      freeze_stock: false,
      remark: `${MARK} 成品仓按车间盘`
    },
    tokGoods
  )
  check('成品仓按「工程车间」建单成功', rGoods.code === 0, `code=${rGoods.code} ${rGoods.message}`)
  if (rGoods.code === 0) {
    createdChecks.push(rGoods.data._id)
    check(
      `明细条数 = 工程车间物料数（${nGongcheng}）`,
      Number(rGoods.data.item_count) === nGongcheng,
      `实际 ${rGoods.data.item_count}`
    )
    const audit = await auditItems(rGoods.data._id, W2, '工程车间')
    check('明细全部来自「工程车间」（无一混入其它车间）', audit.wrong === 0, `混入 ${audit.wrong} 条：${JSON.stringify(audit.sample)}`)
  }

  // 全盘守卫：选了细分类但没带 confirm_full_scan，配件仓（1756 项 >> 200）也必须放行
  const rSmall = await callRaw(
    'check',
    'create',
    {
      type: 'sample',
      warehouse_id: W1,
      scope: { categories: [], sub_categories: ['A001 板材型材'], material_ids: [] },
      freeze_stock: false,
      remark: `${MARK} 配件仓按编号分类盘`
    },
    tokParts
  )
  check('配件仓按「A001 板材型材」建单成功（没被全盘守卫误拦）', rSmall.code === 0, `code=${rSmall.code} ${rSmall.message}`)
  if (rSmall.code === 0) {
    createdChecks.push(rSmall.data._id)
    check(`明细条数 = A001 板材型材物料数（${nA001}）`, Number(rSmall.data.item_count) === nA001, `实际 ${rSmall.data.item_count}`)
    const audit = await auditItems(rSmall.data._id, W1, 'A001 板材型材')
    check('明细全部来自「A001 板材型材」', audit.wrong === 0, `混入 ${audit.wrong} 条`)
  }

  // 守卫仍生效：不带任何范围 + 不带 confirm，配件仓必然被拒
  const rFull = await callRaw(
    'check',
    'create',
    { type: 'full', warehouse_id: W1, scope: { categories: [], sub_categories: [], material_ids: [] }, freeze_stock: false },
    tokParts
  )
  check('不带范围时全盘守卫仍然生效（拒绝）', rFull.code !== 0, `code=${rFull.code}`)

  /* ---------- C/E UI 层 ---------- */
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  try {
    /* C 成品仓管 → 建盘点页 */
    console.log('\nC. 成品仓管 → 创建盘点任务')
    await loginAs(page, accounts.sk_goods)
    await page.goto(`${ADMIN_URL}/check/create`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)

    const switched = await pickSampleType(page)
    check('能切到「抽盘」（切了才显示盘点范围）', switched)
    await sleep(500)

    const ph = await readScopeSelectText(page)
    check('范围下拉的提示语是「车间」，不是「分类」', ph.includes('车间') && !ph.includes('成品'), `实际「${ph}」`)
    const tip = await readScopeTip(page)
    check('范围下方的说明也按仓库语义写（车间）', tip.includes('车间'), `实际「${tip}」`)

    let opts = await readScopeOptions(page)
    console.log('  选项：', JSON.stringify(opts))
    check('选项里没有「成品」这种大类', !opts.includes('成品'), JSON.stringify(opts))
    check(
      '选项就是 3 个车间',
      ['工程车间', '节能炉车间', '西厨车间'].every((t) => opts.includes(t)),
      JSON.stringify(opts)
    )
    await page.screenshot({ path: path.join(OUT_DIR, '成品仓-创建盘点-车间范围.png') })
    await page.keyboard.press('Escape')
    await sleep(300)

    /* D 成品仓管 → 盘点列表范围列 */
    console.log('\nD. 成品仓管 → 盘点列表「盘点范围」列')
    await page.goto(`${ADMIN_URL}/check/list`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    const listText = await page.evaluate(() => document.body.innerText || '')
    check('列表里能看到「车间: 工程车间」', listText.includes('车间: 工程车间'), listText.slice(0, 160).replace(/\s+/g, ' '))
    check('列表里没有把仓库名「成品」当范围列出来', !/分类:\s*成品/.test(listText))
    await page.screenshot({ path: path.join(OUT_DIR, '成品仓-盘点列表-范围文案.png') })

    /* E 配件仓管（正向对照） */
    console.log('\nE. 配件仓管 → 创建盘点任务（正向对照）')
    await loginAs(page, accounts.sk_parts)
    await page.goto(`${ADMIN_URL}/check/create`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    await pickSampleType(page)
    await sleep(500)
    const ph2 = await readScopeSelectText(page)
    check('配件仓范围提示语是「编号分类」', ph2.includes('编号分类'), `实际「${ph2}」`)
    opts = await readScopeOptions(page)
    console.log('  选项（前 5）：', JSON.stringify(opts.slice(0, 5)))
    check('选项含「A001 板材型材」这类编号分类', opts.some((o) => o.includes('A001')), JSON.stringify(opts.slice(0, 5)))
    check('选项里没有「配件」这种大类', !opts.includes('配件'), JSON.stringify(opts))
    await page.screenshot({ path: path.join(OUT_DIR, '配件仓-创建盘点-编号分类范围.png') })
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
