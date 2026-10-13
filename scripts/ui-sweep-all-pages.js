/**
 * ============================================================
 * 小程序全页面遍历体检（真机视口 390×844）
 * ------------------------------------------------------------
 * 做什么：
 *   1. 把页面里硬编码的生产接口 http://119.91.206.235:3000 请求
 *      在浏览器层**重定向到本地 127.0.0.1:3000** —— 保证测试零污染生产
 *   2. 按页面所需角色分别注入登录态（老板/仓管/入库/出库/采购）
 *   3. 逐个打开 27 个页面，收集：
 *        · 页面运行时报错（pageerror）
 *        · console.error
 *        · 请求失败（网络层 4xx/5xx/超时）
 *        · 业务返回 code !== 0（接口报错）
 *        · 是否白屏 / 有没有把数据渲染出来
 *   4. 逐页截图，输出汇总表与 JSON
 *
 * 用法：node scripts/ui-sweep-all-pages.js
 *       H5_BASE=http://localhost:5199   （默认）
 * ============================================================
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const http = require('http')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const H5 = process.env.H5_BASE || 'http://localhost:5199'
const LOCAL_API = process.env.LOCAL_API || 'http://127.0.0.1:3000'
const PROD_API = 'http://119.91.206.235:3000'

const OUT_DIR = path.join(__dirname, '..', '.tmp-local-audit')
const SHOT_DIR = path.join(OUT_DIR, 'screenshots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

// ---------- 本地 API 直调（用于取真实 id、注入登录态） ----------
function apiCall(module, action, data, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ action, data })
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(`${LOCAL_API}/api/${module}`, { method: 'POST', headers, timeout: 15000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch (e) { resolve({ code: -999 }) } })
    })
    req.on('error', () => resolve({ code: -1 }))
    req.on('timeout', () => { req.destroy(); resolve({ code: -1 }) })
    req.write(payload)
    req.end()
  })
}

// ---------- 页面清单：按「谁该看这个页面」分组 ----------
const IDENTITY_PAGES = {
  // 老板视角
  dev_boss: [
    ['pages/index/index', '首页'],
    ['pages/boss/dashboard', '老板·数据总览'],
    ['pages/boss/trend', '老板·趋势'],
    ['pages/boss/stock', '老板·库存'],
    ['pages/boss/orders', '老板·单据'],
    ['pages/boss/warning', '老板·预警'],
    ['pages/my/profile', '我的']
  ],
  // 仓管视角
  dev_sk: [
    ['pages/index/index', '首页'],
    ['pages/storekeeper/dashboard', '仓管·工作台'],
    ['pages/storekeeper/pending', '仓管·待办'],
    ['pages/storekeeper/orders', '仓管·单据'],
    ['pages/storekeeper/stock', '仓管·库存'],
    ['pages/check/list', '盘点·列表'],
    ['pages/check/submit', '盘点·提交'],
    ['pages/in/history', '入库·历史'],
    ['pages/out/history', '出库·历史'],
    ['pages/my/profile', '我的']
  ],
  // 入库员
  dev_in: [
    ['pages/index/index', '首页'],
    ['pages/in/submit', '入库·提交'],
    ['pages/in/history', '入库·历史']
  ],
  // 出库员
  dev_out: [
    ['pages/index/index', '首页'],
    ['pages/out/submit', '出库·提交'],
    ['pages/out/history', '出库·历史']
  ],
  // 采购员
  dev_purchase: [
    ['pages/index/index', '首页'],
    ['pages/purchase/submit', '采购·提交'],
    ['pages/purchase/history', '采购·历史'],
    ['pages/purchase/ledger', '采购·对账']
  ],
  // 未登录也能看的
  __anon__: [
    ['pages/login/login', '登录页'],
    ['pages/agreement/user', '用户协议'],
    ['pages/agreement/privacy', '隐私政策']
  ]
}

// 详情页单独跑（要带 id）
const DETAIL_PAGES = [
  ['pages/in/detail', '入库·详情', 'in', 'dev_sk'],
  ['pages/out/detail', '出库·详情', 'out', 'dev_sk'],
  ['pages/check/detail', '盘点·详情', 'check', 'dev_sk'],
  ['pages/purchase/detail', '采购·详情', 'inbound', 'dev_purchase']
]

/** 从列表接口里挖出第一条单据的真实 id */
function digId(resp) {
  const d = resp && resp.data
  if (!d) return ''
  const list = Array.isArray(d) ? d : (d.list || d.rows || [])
  if (!Array.isArray(list) || !list.length) return ''
  const it = list[0]
  return String(it._id || it.id || '')
}

async function main() {
  console.log('='.repeat(78))
  console.log('  小程序全页面遍历体检')
  console.log(`  页面地址：${H5}`)
  console.log(`  接口地址：${LOCAL_API}（已把页面里的 ${PROD_API} 重定向到本地）`)
  console.log('='.repeat(78))

  // ---------- 先拿详情页要用的真实 id ----------
  const bossLogin = await apiCall('auth', 'login', { dev_openid: 'dev_boss' })
  const bossToken = bossLogin.data?.token
  if (!bossToken) {
    console.error('无法登录 dev_boss，请先执行 cd server && npm run seed:dev')
    process.exit(1)
  }

  const ids = {}
  const inList = await apiCall('inbound', 'list', { page: 1, pageSize: 1 }, bossToken)
  const outList = await apiCall('outbound', 'list', { page: 1, pageSize: 1 }, bossToken)
  const checkList = await apiCall('check', 'list', { page: 1, pageSize: 1 }, bossToken)
  ids.in = digId(inList)
  ids.out = digId(outList)
  ids.check = digId(checkList)
  ids.inbound = ids.in
  console.log(`\n详情页测试用 id：入库=${ids.in || '（无）'} 出库=${ids.out || '（无）'} 盘点=${ids.check || '（无）'}\n`)

  const browser = await chromium.launch({ executablePath: CHROME })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()

  // ---------- 把生产接口重定向到本地 ----------
  await page.route(`${PROD_API}/**`, async (route) => {
    const u = route.request().url().replace(PROD_API, LOCAL_API)
    await route.continue({ url: u })
  })

  const results = []
  let current = { pageErrors: [], consoleErrors: [], netFails: [], apiFails: [] }

  page.on('pageerror', (e) => current.pageErrors.push(String(e.message || e).slice(0, 200)))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const t = msg.text()
    // dev server 的 HMR/websocket 噪音、favicon 不算问题
    if (/favicon|\[vite\]|WebSocket|hmr/i.test(t)) return
    current.consoleErrors.push(t.slice(0, 200))
  })
  page.on('requestfailed', (req) => {
    const u = req.url()
    if (/favicon/.test(u)) return
    current.netFails.push(`${req.method()} ${u.slice(0, 100)} → ${req.failure()?.errorText || 'failed'}`)
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (!u.includes('/api/')) return
    if (res.status() >= 400) {
      current.netFails.push(`HTTP ${res.status()} ${u.slice(0, 100)}`)
    }
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await res.json()
      if (body && typeof body.code === 'number' && body.code !== 0) {
        const body2 = JSON.parse(res.request().postData() || '{}')
        current.apiFails.push(`${body2.action || '?'} → code=${body.code} ${body.message || ''}`)
      }
    } catch (e) { /* 非 JSON 或已被消费，忽略 */ }
  })

  /** 注入某个身份的登录态 */
  async function setIdentity(openid) {
    await page.goto(H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(1500)
    if (openid === '__anon__') {
      await page.evaluate(() => {
        try { uni.removeStorageSync('sl_token'); uni.removeStorageSync('sl_user') } catch (e) {}
      })
      return
    }
    const r = await apiCall('auth', 'login', { dev_openid: openid })
    if (!r.data?.token) throw new Error(`登录失败：${openid} → ${r.message}`)
    await page.evaluate((payload) => {
      uni.setStorageSync('sl_token', payload.token)
      uni.setStorageSync('sl_user', payload.user)
    }, { token: r.data.token, user: r.data.user })
  }

  /** 打开一个页面并体检 */
  async function checkPage(route, label, identity, query = '') {
    current = { pageErrors: [], consoleErrors: [], netFails: [], apiFails: [] }
    const url = `${H5}/#/${route}${query}`
    let navOk = true
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(2600)
    } catch (e) {
      navOk = false
      current.pageErrors.push('打开页面失败：' + e.message.slice(0, 120))
    }

    const dom = await page.evaluate(() => {
      const body = document.body
      const txt = (body.innerText || '').replace(/\s+/g, ' ').trim()
      const uniPages = document.querySelectorAll('uni-page')
      const visible = uniPages.length ? uniPages[uniPages.length - 1] : body
      const vTxt = (visible.innerText || '').replace(/\s+/g, ' ').trim()
      return {
        textLen: txt.length,
        visibleLen: vTxt.length,
        head: vTxt.slice(0, 110),
        hasError: /加载失败|网络错误|请求失败|undefined|null/i.test(vTxt) && vTxt.length < 400
      }
    })

    const shot = path.join(SHOT_DIR, `${route.replace(/\//g, '_')}${query ? '_detail' : ''}_${identity}.png`)
    try { await page.screenshot({ path: shot }) } catch (e) { /* ignore */ }

    const problems = []
    if (!navOk) problems.push('页面打不开')
    if (dom.visibleLen < 12) problems.push('疑似白屏（可视内容过少）')
    if (current.pageErrors.length) problems.push(`运行时报错×${current.pageErrors.length}`)
    if (current.consoleErrors.length) problems.push(`控制台报错×${current.consoleErrors.length}`)
    if (current.apiFails.length) problems.push(`接口报错×${current.apiFails.length}`)
    // 403 属于「权限没给够」，单独标注（有些页面本来就该被拦）
    const is403 = current.apiFails.some((f) => f.includes('code=403'))

    const row = {
      identity, route, label, query, problems, is403,
      textLen: dom.visibleLen,
      head: dom.head,
      pageErrors: current.pageErrors,
      consoleErrors: current.consoleErrors,
      netFails: current.netFails,
      apiFails: current.apiFails,
      shot
    }
    results.push(row)

    const flag = problems.length ? (is403 ? '△' : '✗') : '✓'
    console.log(`  ${flag} [${identity.replace('dev_', '').padEnd(8)}] ${label.padEnd(14)} ${route.padEnd(30)} ${problems.length ? problems.join(' / ') : '正常'}`)
    if (problems.length && !is403) {
      for (const e of current.pageErrors.slice(0, 2)) console.log(`        · 报错：${e}`)
      for (const e of current.apiFails.slice(0, 3)) console.log(`        · 接口：${e}`)
      for (const e of current.netFails.slice(0, 2)) console.log(`        · 网络：${e}`)
    }
    return row
  }

  // ---------- 按身份分组遍历 ----------
  console.log('─'.repeat(78))
  console.log('  第一轮：各角色首页与业务页')
  console.log('─'.repeat(78))

  for (const [identity, pages] of Object.entries(IDENTITY_PAGES)) {
    console.log(`\n【身份：${identity}】`)
    await setIdentity(identity)
    for (const [route, label] of pages) {
      await checkPage(route, label, identity)
    }
  }

  console.log('\n' + '─'.repeat(78))
  console.log('  第二轮：详情页（带真实单据 id）')
  console.log('─'.repeat(78))
  for (const [route, label, idKey, identity] of DETAIL_PAGES) {
    await setIdentity(identity)
    const id = ids[idKey]
    if (!id) {
      console.log(`  − [${identity.replace('dev_', '')}] ${label}：本地库暂无该类型单据，跳过`)
      continue
    }
    await checkPage(route, label, identity, `?id=${id}`)
  }

  await browser.close()

  // ---------- 汇总 ----------
  const bad = results.filter((r) => r.problems.length && !r.is403)
  const denied = results.filter((r) => r.is403)
  const good = results.filter((r) => !r.problems.length)

  console.log('\n' + '='.repeat(78))
  console.log('  遍历结果汇总')
  console.log('='.repeat(78))
  console.log(`  页面总检查次数：${results.length}`)
  console.log(`  正常          ：${good.length}`)
  console.log(`  有问题        ：${bad.length}`)
  console.log(`  权限被拦(403) ：${denied.length}`)

  if (bad.length) {
    console.log('\n  ---- 需要处理的问题页 ----')
    for (const r of bad) {
      console.log(`\n  ✗ ${r.label}（${r.route} ${r.query}） 身份=${r.identity}`)
      r.pageErrors.slice(0, 3).forEach((e) => console.log(`      运行时报错：${e}`))
      r.consoleErrors.slice(0, 3).forEach((e) => console.log(`      控制台报错：${e}`))
      r.apiFails.slice(0, 5).forEach((e) => console.log(`      接口报错  ：${e}`))
      r.netFails.slice(0, 3).forEach((e) => console.log(`      网络失败  ：${e}`))
    }
  }

  if (denied.length) {
    console.log('\n  ---- 权限被拦的页面（需确认是否符合预期）----')
    for (const r of denied) {
      console.log(`  △ ${r.label}（${r.route}）身份=${r.identity} → ${r.apiFails.join(' ; ')}`)
    }
  }

  const reportPath = path.join(OUT_DIR, 'ui-sweep-result.json')
  fs.writeFileSync(reportPath, JSON.stringify({ results, summary: { total: results.length, good: good.length, bad: bad.length, denied: denied.length } }, null, 2), 'utf8')
  console.log(`\n  明细已落盘：${reportPath}`)
  console.log(`  截图目录  ：${SHOT_DIR}`)
  console.log('='.repeat(78))

  process.exit(0)
}

main().catch((e) => { console.error('遍历异常：', e); process.exit(1) })
