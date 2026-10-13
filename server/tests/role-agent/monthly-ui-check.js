/**
 * 月结表 · 验收（2026-10-13）
 * ============================================================
 * 用户需求：「成品仓 增加一个月结功能（参考线下 Excel 月报表），直接在后台做，前端不用；
 *   做完加导出功能（也出表格）；老板和厂长看板 加一个查看月结表的入口」
 *
 * 判据：
 *   A 源码层 —— 后端两个 action、前端页面、page-matrix / 菜单 / 路由 / 看板入口都接入
 *   B 接口层 ——
 *     · admin 调 monthly：行数 = 成品仓物料数、数量守恒（期初+收入-发出=期末）、金额字段齐全
 *     · boss 也能调（只读）
 *     · 纯仓管调：能调通但金额字段被脱敏（begin_amount 等不存在）
 *     · 配件仓管调成品仓 → 403（仓库隔离）
 *     · 领料员调 → 403（角色拒绝）
 *     · monthlyExport 返回可解码的 xlsx（ZIP 头 PK）
 *   C UI 层 ——
 *     · 厂长看板有「月结表」按钮，点了进 /stats/monthly，标题含「月报表」，表格渲染
 *     · 成品仓管的侧边栏「数据统计」里有「月结表」；打开后**看不到金额列**（表头无「金额」）
 *     · 管理员点「导出 Excel」真的触发下载，文件名含「月报表」
 *   D 对照实验（回退后重跑，应大量失败）
 *
 * 用法：node tests/role-agent/monthly-ui-check.js
 * 前提：静态服务 5179（admin/dist-local）+ 后端 3000
 * 临时账号前缀 RA_MON_，跑完自删；不写任何业务数据。
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
const OUT_DIR = path.join(__dirname, 'results', 'monthly')
const PREFIX = 'RA_MON_'
const PASSWORD = 'RA_MON_Pwd_2026'
const W_GOODS = 2 // 成品仓
const W_PARTS = 1 // 配件仓

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
  const mk = (u, n, roles, codes) => ({ u, n, roles, codes })
  const accounts = [
    mk(`${PREFIX}boss`, '验收·老板', ['boss'], []),
    mk(`${PREFIX}director`, '验收·厂长', ['director'], ['peijian', 'chengpin']),
    mk(`${PREFIX}sk_goods`, '验收·成品仓管', ['storekeeper'], ['chengpin']),
    mk(`${PREFIX}sk_parts`, '验收·配件仓管', ['storekeeper'], ['peijian']),
    mk(`${PREFIX}out`, '验收·领料员', ['out'], ['peijian'])
  ]
  for (const a of accounts) {
    const whIds = a.codes.map((c) => idByCode[c]).filter(Boolean)
    await execute(
      `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, NOW())`,
      [a.u, hash, a.n, JSON.stringify(a.roles), JSON.stringify(whIds)]
    )
  }
  return Object.fromEntries(accounts.map((a) => [a.u.slice(PREFIX.length), a.u]))
}

async function cleanup() {
  try {
    await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
    const left = await query(`SELECT COUNT(*) AS c FROM users WHERE username LIKE '${PREFIX}%'`)
    console.log(`\n（已清理临时账号：剩 ${left[0].c} 个，应为 0）`)
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

;(async () => {
  console.log('\n═══ 月结表验收（2026-10-13）═══\n')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  /* ---------- A 源码层 ---------- */
  console.log('A. 源码层（防回退）')
  const statsSrc = fs.readFileSync(path.join(ROOT, 'server', 'src', 'modules', 'stats.js'), 'utf8')
  // 判据必须限定在「已注册」—— 光函数在文件里不算数（对照实验暴露过：只删注册会误过）
  check('后端 stats.monthly 存在并注册（roleRules + actions）',
    /monthly:\s*\['boss', 'admin', 'storekeeper', 'director'\]/.test(statsSrc) && /notifyWarning,\s*monthly, monthlyExport/.test(statsSrc.replace(/\s+/g, ' ')))
  check('后端 stats.monthlyExport 存在并注册', /monthlyExport:\s*\['boss'/.test(statsSrc) && /monthly, monthlyExport/.test(statsSrc.replace(/\s+/g, ' ')))
  check('月结页文件存在', fs.existsSync(path.join(ROOT, 'admin', 'src', 'views', 'stats', 'monthly.vue')))
  const matrix = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'constants', 'page-matrix.json'), 'utf8')
  check('page-matrix 已登记 /stats/monthly', /"\/stats\/monthly"/.test(matrix))
  const menuSrc = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'constants', 'menu.js'), 'utf8')
  check('数据统计菜单包含 /stats/monthly', /'\/stats\/monthly'/.test(menuSrc))
  const routerSrc = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'router', 'index.js'), 'utf8')
  check('路由已注册 StatsMonthly', /StatsMonthly/.test(routerSrc))
  const dashSrc = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'views', 'dashboard.vue'), 'utf8')
  // 要的是「模板里真有按钮 + 且只给老板/厂长」，光有 computed 定义不算（对照实验暴露过）
  check('看板有月结表入口且只给老板/厂长',
    /v-if="canMonthly"[\s\S]{0,200}月结表/.test(dashSrc) && /canMonthly[\s\S]{0,120}hasRole\('boss', 'director'\)/.test(dashSrc.replace(/\s+/g, ' ')))

  /* ---------- 准备账号 ---------- */
  const accounts = await ensureAccounts()
  const tokAdmin = await loginAdmin('admin', '123456')
  const tokBoss = await loginAdmin(accounts.boss, PASSWORD)
  const tokGoods = await loginAdmin(accounts.sk_goods, PASSWORD)
  const tokParts = await loginAdmin(accounts.sk_parts, PASSWORD)
  const tokOut = await loginAdmin(accounts.out, PASSWORD)

  /* ---------- B 接口层 ---------- */
  console.log('\nB. 接口层')

  const rAdmin = await callRaw('stats', 'monthly', { month: '2026-10', warehouse_id: W_GOODS }, tokAdmin)
  check('admin 调 monthly 成功', rAdmin.code === 0, `code=${rAdmin.code} ${rAdmin.message}`)
  if (rAdmin.code === 0) {
    const d = rAdmin.data
    const matCnt = await query('SELECT COUNT(*) c FROM materials WHERE is_deleted=0 AND warehouse_id=?', [W_GOODS])
    check(`行数 = 成品仓物料数（${matCnt[0].c}）`, d.list.length === Number(matCnt[0].c), `实际 ${d.list.length}`)
    check('返回公司名与仓库名', !!d.company_name && !!d.warehouse_name, JSON.stringify({ c: d.company_name, w: d.warehouse_name }))
    let bad = 0
    let sample = null
    for (const it of d.list) {
      if (Math.abs(it.begin_qty + it.in_qty - it.out_qty - it.end_qty) > 0.001) {
        bad++
        if (!sample) sample = it
      }
    }
    check('每一行数量守恒（期初+收入-发出=期末）', bad === 0, `不守恒 ${bad} 行${sample ? ' 例:' + JSON.stringify(sample) : ''}`)
    check('admin 能拿到金额字段（不脱敏）', d.list.length === 0 || d.list[0].end_amount !== undefined, JSON.stringify(Object.keys(d.list[0] || {})))
    const s = d.summary
    check(
      '合计数量也守恒',
      Math.abs(s.begin_qty + s.in_qty - s.out_qty - s.end_qty) < 0.001,
      JSON.stringify(s)
    )
  }

  const rBoss = await callRaw('stats', 'monthly', { month: '2026-10', warehouse_id: W_GOODS }, tokBoss)
  check('boss 调 monthly 成功（只读可看）', rBoss.code === 0, `code=${rBoss.code} ${rBoss.message}`)

  const rGoods = await callRaw('stats', 'monthly', { month: '2026-10', warehouse_id: W_GOODS }, tokGoods)
  check('成品仓管调 monthly 成功', rGoods.code === 0, `code=${rGoods.code} ${rGoods.message}`)
  if (rGoods.code === 0) {
    const row0 = rGoods.data.list[0] || {}
    check('纯仓管的金额字段已脱敏（end_amount 不下发）', row0.end_amount === undefined, JSON.stringify(Object.keys(row0)))
  }

  const rParts = await callRaw('stats', 'monthly', { month: '2026-10', warehouse_id: W_GOODS }, tokParts)
  check('配件仓管调成品仓月结被拒（仓库隔离）', rParts.code !== 0, `code=${rParts.code}`)

  const rOut = await callRaw('stats', 'monthly', { month: '2026-10', warehouse_id: W_PARTS }, tokOut)
  check('领料员调月结被拒（角色拒绝）', rOut.code !== 0, `code=${rOut.code}`)

  const rExp = await callRaw('stats', 'monthlyExport', { month: '2026-10', warehouse_id: W_GOODS }, tokAdmin)
  check('monthlyExport 返回成功', rExp.code === 0, `code=${rExp.code} ${rExp.message}`)
  if (rExp.code === 0) {
    const buf = Buffer.from(rExp.data.content_base64, 'base64')
    check('导出内容是合法的 xlsx（ZIP 头 PK）', buf.length > 1000 && buf[0] === 0x50 && buf[1] === 0x4b, `大小 ${buf.length}`)
    check('导出文件名含「月报表」', (rExp.data.filename || '').includes('月报表'), rExp.data.filename)
  }

  /* ---------- C UI 层 ---------- */
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

  try {
    /* C1 厂长：看板入口 → 月结页 */
    console.log('\nC1. 厂长：看板入口 → 月结页')
    await loginAs(page, accounts.director)
    await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    const btnVisible = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => (b.innerText || '').includes('月结表'))
    )
    check('厂长看板有「月结表」按钮', btnVisible)
    if (btnVisible) {
      await page.locator('button', { hasText: '月结表' }).first().click()
      await sleep(2200)
      check('点击后进入 /stats/monthly', page.url().includes('/stats/monthly'), page.url())
      const bodyText = await page.evaluate(() => document.body.innerText || '')
      check('页面标题是「…月报表」', /月报表/.test(bodyText), bodyText.slice(0, 120).replace(/\s+/g, ' '))
      check('表头含「期初结存 / 本月收入 / 本月发出 / 期末结存」',
        ['期初结存', '本月收入', '本月发出', '期末结存'].every((t) => bodyText.includes(t)))
      const rowCount = await page.evaluate(() => document.querySelectorAll('.monthly-table tbody tr').length)
      check('表格渲染出数据行（成品仓 147 行）', rowCount >= 100, `实际 ${rowCount} 行`)
      await page.screenshot({ path: path.join(OUT_DIR, '厂长-月结表.png'), fullPage: false })
    }

    /* C2 老板：看板也有入口 */
    console.log('\nC2. 老板：看板入口')
    await loginAs(page, accounts.boss)
    await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    const bossBtn = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => (b.innerText || '').includes('月结表'))
    )
    check('老板看板也有「月结表」按钮', bossBtn)

    /* C3 成品仓管：侧边栏有入口，但看不到金额列 */
    console.log('\nC3. 成品仓管：侧边栏入口 + 金额脱敏')
    await loginAs(page, accounts.sk_goods)
    await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    // 「数据统计」是折叠分组：先展开再读子菜单（否则 innerText 里没有子项文字）
    await page.locator('.el-sub-menu__title', { hasText: '数据统计' }).first().click().catch(() => {})
    await sleep(600)
    const menuText = await page.evaluate(() => document.querySelector('.el-menu')?.innerText || '')
    check('成品仓管侧边栏「数据统计」下有「月结表」', menuText.includes('月结表'), menuText.replace(/\s+/g, ' ').slice(0, 200))
    const dashBtn = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => (b.innerText || '').includes('月结表'))
    )
    check('成品仓管看板没有「月结表」快捷按钮（入口只给老板/厂长）', !dashBtn)
    await page.goto(`${ADMIN_URL}/stats/monthly`, { waitUntil: 'domcontentloaded' })
    await sleep(2400)
    const headerText = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('.monthly-table thead th')]
      return ths.map((t) => (t.innerText || '').trim()).join('|')
    })
    check('成品仓管看不到任何「金额」列', !headerText.includes('金额'), headerText)
    check('数量列仍在', headerText.includes('数量'), headerText)
    await page.screenshot({ path: path.join(OUT_DIR, '成品仓管-月结表-无金额.png') })

    /* C4 管理员：导出真的触发下载 */
    console.log('\nC4. 管理员：导出 Excel 触发下载')
    await loginAs(page, 'admin', '123456')
    await page.goto(`${ADMIN_URL}/stats/monthly`, { waitUntil: 'domcontentloaded' })
    await sleep(2400)
    const dlPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    await page.locator('button', { hasText: '导出 Excel' }).first().click()
    const dl = await dlPromise
    check('点击「导出 Excel」触发下载', !!dl)
    if (dl) {
      const fname = dl.suggestedFilename()
      check('下载文件名含「月报表」且为 .xlsx', /月报表/.test(fname) && /\.xlsx$/.test(fname), fname)
      const saveTo = path.join(OUT_DIR, fname)
      await dl.saveAs(saveTo)
      const sz = fs.statSync(saveTo).size
      check('下载文件非空（>5KB）', sz > 5000, `${sz} bytes`)
      const head = fs.readFileSync(saveTo).slice(0, 2).toString('latin1')
      check('下载文件是合法 xlsx（PK 头）', head === 'PK')
    }
  } finally {
    await browser.close()
    await cleanup()
  }

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  console.log('截图/导出目录：', OUT_DIR)
  process.exit(fail ? 1 : 0)
})().catch(async (e) => {
  console.error('验收脚本异常：', e)
  await cleanup()
  process.exit(1)
})
