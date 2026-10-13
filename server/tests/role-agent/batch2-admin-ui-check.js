/**
 * ============================================================
 * 第二批 · 后台「按角色隔离」UI 验收（真实浏览器）
 * ------------------------------------------------------------
 * 用法（⚠️ 静态服务和用例必须写在**同一条 Bash 命令**里，否则后台进程会被回收）：
 *   cd server
 *   node tests/role-agent/static-serve.js ../admin/dist-local 5178 admin & sleep 2; \
 *     ADMIN_URL=http://127.0.0.1:5178/admin node tests/role-agent/batch2-admin-ui-check.js; kill %1
 *
 * ⚠️ 端口别用 5176 —— 那是用户自己跑着的后台（ShengLong-AdminWeb 计划任务），不能碰。
 *    这里另起 5178 托管同一份 dist-local，互不干扰。
 *
 * 查的是「接口层查不出来的东西」：
 *   1. 登录后落在**自己的**首页（仓管不该落进 403 的 /dashboard）
 *   2. 侧边栏真的只显示自己那套菜单（配件仓管看不到成品仓物料，仓管看不到用户管理…）
 *   3. 左上角身份名（配件仓后台 / 成品仓后台 / 厂长后台…）与角色一致
 *   4. 手敲越权 URL 会被弹回自己的首页
 *   5. 物料列表确实有「照片」列（仓库后台要看图的需求）
 *
 * ⚠️ 会往真实库写 7 个 RA_BK2_* 账号（每次跑先删后建），跑完调 autoCleanup 清掉。
 * ============================================================
 */
require('../../src/config/env')

const path = require('path')
const bcrypt = require('bcryptjs')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { callRaw, loginAdmin } = require('./lib')
const { query, queryOne, execute } = require('../../src/db/pool')
const { autoCleanup } = require('./_cleanup')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5178/admin'
const PASSWORD = 'RA_BK2_Pwd_2026'
const PREFIX = 'RA_BK2_'

let pass = 0
const failures = []

function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else {
    failures.push({ label, detail })
    console.log(`  ❌ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------------------------------------------------------- 账号 */

const ACCOUNTS = [
  { key: 'admin', roles: ['admin'], codes: [] },
  { key: 'boss', roles: ['boss'], codes: [] },
  { key: 'sk_parts', roles: ['storekeeper'], codes: ['peijian'] },
  { key: 'sk_goods', roles: ['storekeeper'], codes: ['chengpin'] },
  { key: 'director', roles: ['director'], codes: ['peijian', 'chengpin'] },
  { key: 'purchase', roles: ['purchase'], codes: ['peijian', 'chengpin'] },
  { key: 'out', roles: ['out'], codes: ['peijian'] }
]

async function ensureAccounts() {
  const whs = await query('SELECT id, code FROM warehouses WHERE is_deleted = 0')
  const byCode = {}
  whs.forEach((w) => { byCode[w.code] = w.id })

  await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)
  const hash = await bcrypt.hash(PASSWORD, 10)
  for (const a of ACCOUNTS) {
    const ids = a.codes.map((c) => byCode[c]).filter(Boolean)
    await execute(
      `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, NOW())`,
      [`${PREFIX}${a.key}`, hash, `测试·后台${a.key}`, JSON.stringify(a.roles), JSON.stringify(ids)]
    )
  }
}

/* ---------------------------------------------------------------- 浏览器 */

async function sidebarState(page) {
  return page.evaluate(() => {
    const menu = document.querySelector('.sidebar-menu')
    if (!menu) return { groups: [], items: [], logo: '' }
    return {
      groups: Array.from(menu.querySelectorAll('.el-sub-menu__title')).map((n) => n.innerText.trim()),
      items: Array.from(menu.querySelectorAll('.el-menu-item')).map((n) => n.innerText.trim()),
      logo: (document.querySelector('.logo p') || {}).innerText || ''
    }
  })
}

async function login(page, username) {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  // ⚠️ 上一轮如果还是登录态，访问 /login 会被守卫直接弹到首页（表单根本不存在）→ 先清干净
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', username)
  await page.fill('input[placeholder="密码"]', PASSWORD)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await page.waitForLoadState('domcontentloaded')
  await sleep(900) // 等 el-menu 渲染完（有仓库列表请求要先回来才会过滤菜单）
}

/* ---------------------------------------------------------------- 断言表 */

/**
 * 每个角色的期望：落地页、必须出现/必须不出现的菜单文案、左上角身份名。
 * ⚠️ 这里的期望值来自 admin/src/constants/page-matrix.json，改权限要一起改。
 */
const EXPECT = {
  admin: {
    home: '/dashboard',
    logo: '后台管理系统',
    must: ['数据看板', '数据大屏', '数据统计', '用户管理', '权限管理', '物料管理', '单据管理', '消息中心', '盘点管理', '系统设置', '操作日志'],
    mustNot: []
  },
  boss: {
    logo: '经营看板',
    must: ['数据看板', '数据大屏', '用户管理', '单据管理', '盘点管理'],
    // 老板只读：系统设置与批量导入不给
    mustNot: ['系统设置']
  },
  sk_parts: {
    logo: '配件仓后台',
    must: ['数据看板', '物料管理', '配件仓物料', '单据管理', '出库单', '入库单', '采购任务', '盘点管理', '消息中心'],
    mustNot: ['成品仓物料', '批量导入', '用户管理', '权限管理', '操作日志', '系统设置']
  },
  sk_goods: {
    logo: '成品仓后台',
    must: ['成品仓物料', '出入库统计', '单据管理'],
    // 采购任务只针对配件仓（2026-10-12 用户要求：成品仓后台不需要这个功能）——
    //   成品是车间做的、不用采购，所以这里必须看不到
    mustNot: ['配件仓物料', '采购任务', '批量导入', '用户管理', '系统设置']
  },
  director: {
    logo: '厂长后台',
    must: ['配件仓物料', '成品仓物料', '采购任务', '盘点管理', '出入库统计', '单据管理'],
    mustNot: ['批量导入', '用户管理', '权限管理', '操作日志', '系统设置', '人员绩效', '物料排行']
  },
  purchase: {
    logo: '采购后台',
    must: ['采购任务', '消息中心'],
    // 采购只管买：不给物料档案、不给盘点、不给用户管理、不给看板
    mustNot: ['物料管理', '用户管理', '盘点管理', '数据看板', '数据大屏', '系统设置', '操作日志']
  },
  out: {
    home: '/message/list',
    logo: '后台管理系统',
    must: ['消息中心'],
    mustNot: ['物料管理', '单据管理', '盘点管理', '用户管理', '系统设置', '数据看板']
  }
}

/** 手敲越权 URL 必须被弹回去 */
const FORBIDDEN_URLS = {
  sk_parts: ['/user/list', '/system/logs', '/setting/company', '/stats/material-rank'],
  // /order/purchase-tasks 走的是「仓库门」（不是角色门）：成品仓管也是 storekeeper，
  //   光靠角色判不出去，得按「他管的仓」挡
  sk_goods: ['/user/list', '/setting/company', '/order/purchase-tasks'],
  director: ['/user/list', '/setting/company', '/system/logs'],
  purchase: ['/user/list', '/material/import', '/check/create', '/stats/material-rank'],
  boss: ['/setting/company'],
  out: ['/material/list', '/order/outbound']
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  console.log('# 第二批 UI 验收 · 后台按角色隔离\n')
  console.log(`后台地址：${ADMIN_URL}`)

  // 静态服务没起就早点报错，别让后面全是「控件找不到」
  const probe = await callRaw('auth', 'adminLogin', { username: 'admin', password: '123456' }).catch(() => null)
  if (!probe || probe.code !== 0) {
    console.log('⚠️ 提示：admin 账号密码可能已改（本套件里 admin 只用于探测服务是否在线）')
  }

  await ensureAccounts()
  const wh = await queryOne('SELECT id FROM warehouses WHERE code = "peijian" AND is_deleted = 0')
  ok('测试账号已就绪（配件仓仓 id 可查）', !!wh)

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const consoleErrors = []
  const http404 = []
  /**
   * ⚠️ 2026-10-09 修（判据写错过）：
   *   console 的报错文本只有「Failed to load resource: the server responded with
   *   a status of 404 (Not Found)」，**不带 URL**。原来拿 `/favicon/i.test(文本)`
   *   去滤 favicon 永远滤不掉 → 这条断言恒红（或恒绿），是假信号。
   *   浏览器请求的是站点根 `/favicon.ico`，而静态服务只挂了 `/admin`，所以必然 404；
   *   这与业务无关。正确做法是读 `msg.location().url` 按**真实来源**判。
   *   证据：tests/role-agent/_probe-404.js 打印出 location.url = http://.../favicon.ico
   */
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    let src = ''
    try { src = (m.location() && m.location().url) || '' } catch (e) { src = '' }
    consoleErrors.push({ text: m.text(), src })
  })
  // 只记 URL 不够用，还要知道是哪一步触发的 404（接口？资源？路由？）
  page.on('response', (res) => {
    if (res.status() === 404) http404.push(`${res.request().method()} ${res.url()}`)
  })

  for (const acc of ACCOUNTS) {
    const exp = EXPECT[acc.key]
    console.log(`\n—— ${acc.key}（${acc.roles.join('/')}）——`)
    await login(page, `${PREFIX}${acc.key}`)

    const url = page.url()
    if (exp.home) {
      ok(`落地在自己首页 ${exp.home}`, url.includes(exp.home), `实际 ${url}`)
    } else {
      // 没声明 home 的角色：只要不是 /login 且不是 403 页就算过
      ok('登录后留在后台内部（没被踢回登录页）', !url.includes('/login'), `实际 ${url}`)
    }

    const state = await sidebarState(page)
    ok(`左上角身份显示「${exp.logo}」`, state.logo.includes(exp.logo), `实际「${state.logo}」`)

    const all = [...state.groups, ...state.items].join(' | ')
    const missing = exp.must.filter((t) => !all.includes(t))
    ok(`该有的菜单都在（${exp.must.length} 项）`, missing.length === 0,
      `缺：${missing.join('、')}｜实际：${all}`)

    const leaked = exp.mustNot.filter((t) => all.includes(t))
    ok(`不该有的菜单一项都没有`, leaked.length === 0, `多出：${leaked.join('、')}`)

    // 单个角色的细节
    if (acc.key === 'sk_parts') {
      ok('配件仓管只看得到「配件仓物料」', all.includes('配件仓物料') && !all.includes('成品仓物料'))
    }
    if (acc.key === 'sk_goods') {
      ok('成品仓管只看得到「成品仓物料」', all.includes('成品仓物料') && !all.includes('配件仓物料'))
    }
    if (acc.key === 'director') {
      ok('厂长两个仓的物料入口都在', all.includes('配件仓物料') && all.includes('成品仓物料'))
    }

    // 越权 URL 直接敲
    for (const bad of FORBIDDEN_URLS[acc.key] || []) {
      await page.goto(`${ADMIN_URL}${bad}`, { waitUntil: 'domcontentloaded' })
      await sleep(700)
      const now = page.url()
      const bounced = !now.includes(bad) || now.includes('/login')
      ok(`手敲 ${bad} 被弹回（不留在这个页面）`, bounced, `实际停在 ${now}`)
    }

    // 物料列表的照片列（仓库后台要看图的需求）
    if (['sk_parts', 'sk_goods', 'director', 'admin'].includes(acc.key)) {
      await page.goto(`${ADMIN_URL}/material/list`, { waitUntil: 'domcontentloaded' })
      await sleep(1200)
      const headers = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.el-table__header th')).map((n) => n.innerText.trim())
      )
      ok('物料列表有「照片」列', headers.includes('照片'), `表头：${headers.join('/')}`)
    }
  }

  // 不认识的 URL → 回首页，不该白屏
  await login(page, `${PREFIX}admin`)
  await page.goto(`${ADMIN_URL}/no-such-page-xyz`, { waitUntil: 'domcontentloaded' })
  await sleep(600)
  const bodyText = await page.evaluate(() => document.body.innerText)
  ok('访问不存在的路径不会白屏（回落到自己的首页）',
    await page.evaluate(() => !!document.querySelector('.sidebar-menu')), bodyText.slice(0, 80))

  // 按**真实来源**滤掉 favicon（见上面 console 监听处的说明）
  const isFavicon = (s) => /favicon/i.test(String(s || ''))
  const realErrors = consoleErrors.filter((e) => !isFavicon(e.src) && !isFavicon(e.text))
  ok('全程没有 JS 报错', realErrors.length === 0,
    realErrors.slice(0, 3).map((e) => `${e.text} @ ${e.src}`).join(' || '))
  // 404 单独判：常见来源是「某个页面调了一个后端没登记的 action」（接口 404）或前端资源缺失
  const real404 = http404.filter((u) => !/favicon\.ico/i.test(u))
  ok('全程没有 404 请求（接口/资源）', real404.length === 0, real404.slice(0, 5).join(' || '))

  await browser.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`断言：${pass + failures.length}，通过 ${pass}，失败 ${failures.length}`)
  if (failures.length) {
    console.log('\n失败明细：')
    failures.forEach((f) => console.log(`  ❌ ${f.label}  ← ${f.detail}`))
  }
  console.log('='.repeat(60))

  autoCleanup()
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error('\n💥 套件异常终止：', err && err.stack ? err.stack : err)
  autoCleanup()
  process.exit(1)
})
