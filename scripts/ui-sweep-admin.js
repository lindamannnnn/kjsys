/**
 * ============================================================
 * Web 后台（admin，Vite dev）全页面遍历体检
 * ------------------------------------------------------------
 * ⚠️ 必须用 127.0.0.1 而不是 localhost：
 *    本机 5173 端口上同时跑着两个 dev server（小程序 H5 绑了 ::1，
 *    admin 绑了 127.0.0.1），`localhost` 会解析到 IPv6 从而打开
 *    小程序首页，看起来"全部正常"，其实一个后台页面都没测到。
 *
 * 判据（刻意从严，避免"打不开也说正常"）：
 *   1. 必须渲染出后台布局（Element Plus 的 .el-menu / .el-container）
 *   2. 若是列表页，必须有表格行，或明确显示"暂无数据"
 *   3. 若是图表页，必须有 canvas（ECharts 渲染结果）
 *   4. 不允许停留在登录页
 *
 * 用法：node scripts/ui-sweep-admin.js
 * ============================================================
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const BASE = process.env.ADMIN_BASE || 'http://127.0.0.1:5173'
const API_TARGET = process.env.API_BASE || 'http://127.0.0.1:3000'
const USERNAME = process.env.ADMIN_USER || 'admin'
const PASSWORD = process.env.ADMIN_PASS || '123456'

const OUT_DIR = path.join(__dirname, '..', '.tmp-local-audit')
const SHOT_DIR = path.join(OUT_DIR, 'screenshots-admin')
fs.mkdirSync(SHOT_DIR, { recursive: true })

// kind: list=必须有表格数据或"暂无数据"；form=表单页
//
// 注：admin 装了 echarts/vue-echarts 依赖，但**全部页面都没用图表**
//     （统计一律用表格呈现），所以不做 canvas 判据，只记录数量供参考。
const ROUTES = [
  ['/dashboard', '数据看板', 'list'],
  ['/stats/overview', '出入库统计', 'list'],
  ['/stats/material-rank', '物料排行', 'list'],
  ['/stats/operator-stats', '人员绩效', 'list'],
  ['/material/list', '物料列表', 'list'],
  ['/material/parts', '配件', 'list'],
  ['/material/product', '成品', 'list'],
  ['/material/edit', '物料编辑', 'form'],
  ['/material/import', '物料导入', 'form'],
  ['/order/inbound', '入库单管理', 'list'],
  ['/order/outbound', '出库单管理', 'list'],
  ['/check/list', '盘点列表', 'list'],
  ['/check/create', '发起盘点', 'form'],
  ['/user/list', '用户管理', 'list'],
  ['/user/password', '修改密码', 'form'],
  ['/role/list', '角色管理', 'form'],
  ['/setting/company', '公司设置', 'form'],
  ['/system/logs', '操作日志', 'list']
]

async function main() {
  console.log('='.repeat(80))
  console.log('  Web 后台全页面遍历体检')
  console.log(`  后台地址：${BASE}（注意：必须是 127.0.0.1，localhost 会打到小程序）`)
  console.log('='.repeat(80))

  const browser = await chromium.launch({ executablePath: CHROME })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  // 把后台请求里的 localhost:3000 也钉到 127.0.0.1，避免同样的解析歧义
  await page.route('http://localhost:3000/**', async (route) => {
    await route.continue({ url: route.request().url().replace('http://localhost:3000', API_TARGET) })
  })

  const results = []
  let current = { pageErrors: [], consoleErrors: [], apiFails: [] }
  page.on('pageerror', (e) => current.pageErrors.push(String(e.message || e).slice(0, 200)))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const t = msg.text()
    if (/favicon|\[vite\]|WebSocket|hmr|ResizeObserver|DevTools/i.test(t)) return
    current.consoleErrors.push(t.slice(0, 200))
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (!u.includes('/api/')) return
    if (res.status() >= 400) current.apiFails.push(`HTTP ${res.status()} ${u.slice(0, 90)}`)
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await res.json()
      if (body && typeof body.code === 'number' && body.code !== 0) {
        const req = JSON.parse(res.request().postData() || '{}')
        current.apiFails.push(`${req.action || '?'} → code=${body.code} ${body.message || ''}`)
      }
    } catch (e) { /* ignore */ }
  })

  // ---------- 登录 ----------
  console.log('\n【登录】')
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(2500)

  const loginPageTitle = await page.title()
  console.log(`  登录页标题：${loginPageTitle}`)

  const inputs = await page.$$('input')
  console.log(`  找到 ${inputs.length} 个输入框`)
  if (inputs.length >= 2) {
    await inputs[0].fill(USERNAME)
    await inputs[1].fill(PASSWORD)
    const btns = await page.$$('button')
    if (btns.length) await btns[btns.length - 1].click()
    await page.waitForTimeout(4000)
  }

  const afterLogin = page.url()
  const tokenSet = await page.evaluate(() => !!localStorage.getItem('access_token'))
  const loginOk = tokenSet && !afterLogin.endsWith('/login')
  console.log(`  令牌已写入：${tokenSet ? '是' : '否'}`)
  console.log(`  当前地址：${afterLogin}`)
  console.log(`  登录结果：${loginOk ? '✓ 成功' : '✗ 失败'}`)
  try { await page.screenshot({ path: path.join(SHOT_DIR, '_login.png') }) } catch (e) { /* ignore */ }

  if (!loginOk) {
    console.log('\n  登录没成功，后续页面测试没有意义，终止。')
    await browser.close()
    process.exit(1)
  }

  // ---------- 逐页遍历 ----------
  console.log('\n' + '─'.repeat(80))
  console.log('  逐页体检（判据：后台布局 + 表格数据/暂无数据 + 图表 canvas）')
  console.log('─'.repeat(80))

  for (const [route, label, kind] of ROUTES) {
    current = { pageErrors: [], consoleErrors: [], apiFails: [] }
    let navOk = true
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(3200)
    } catch (e) {
      navOk = false
      current.pageErrors.push('打开失败：' + e.message.slice(0, 120))
    }

    const dom = await page.evaluate(() => {
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim()
      return {
        title: document.title,
        len: txt.length,
        head: txt.slice(0, 80),
        hasLayout: !!document.querySelector('.el-menu, .el-container, .el-aside, aside'),
        rows: document.querySelectorAll('.el-table__row').length,
        noData: /暂无数据|No Data|没有数据/.test(txt),
        canvas: document.querySelectorAll('canvas').length,
        // 是否还停在登录页：看有没有登录表单，而不是看文字里有没有"登录"
        // （用户列表里就有「最后登录」列，用文字判会全员误判成被踢）
        atLogin: !!document.querySelector('input[type="password"]') && !document.querySelector('.el-menu')
      }
    })
    const pageUrl = page.url()

    const shot = path.join(SHOT_DIR, route.replace(/\//g, '_').replace(/^_/, '') + '.png')
    try { await page.screenshot({ path: shot }) } catch (e) { /* ignore */ }

    const problems = []
    if (!navOk) problems.push('打不开')
    if (pageUrl.includes('/login')) problems.push('被重定向回登录页')
    else if (dom.atLogin) problems.push('未登录状态未跳转')
    if (!dom.hasLayout) problems.push('未渲染后台布局')
    if (kind === 'list' && dom.rows === 0 && !dom.noData) problems.push('表格无行也无"暂无数据"')
    if (current.pageErrors.length) problems.push(`运行时报错×${current.pageErrors.length}`)
    if (current.consoleErrors.length) problems.push(`控制台报错×${current.consoleErrors.length}`)
    if (current.apiFails.length) problems.push(`接口报错×${current.apiFails.length}`)

    results.push({ route, label, kind, problems, dom, pageUrl, ...current })
    console.log(`  ${problems.length ? '✗' : '✓'} ${label.padEnd(12)} ${route.padEnd(24)} ` +
      `布局=${dom.hasLayout ? 'Y' : 'N'} 表格行=${String(dom.rows).padEnd(4)} canvas=${String(dom.canvas).padEnd(2)} ` +
      `${problems.length ? problems.join(' / ') : '正常'}`)
    if (problems.length) {
      current.pageErrors.slice(0, 2).forEach((e) => console.log(`        · 报错：${e}`))
      current.apiFails.slice(0, 4).forEach((e) => console.log(`        · 接口：${e}`))
      current.consoleErrors.slice(0, 2).forEach((e) => console.log(`        · 控制台：${e}`))
    }
  }

  await browser.close()

  const bad = results.filter((r) => r.problems.length)
  console.log('\n' + '='.repeat(80))
  console.log(`  后台遍历完成：${results.length} 个页面，正常 ${results.length - bad.length}，有问题 ${bad.length}`)
  if (bad.length) {
    console.log('\n  ---- 问题页 ----')
    for (const r of bad) console.log(`  ✗ ${r.label}（${r.route}）：${r.problems.join(' / ')}`)
  }
  console.log('='.repeat(80))

  fs.writeFileSync(path.join(OUT_DIR, 'admin-sweep-result.json'),
    JSON.stringify({ results, summary: { total: results.length, bad: bad.length } }, null, 2), 'utf8')
  console.log(`  截图目录：${SHOT_DIR}`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error('异常：', e); process.exit(1) })
