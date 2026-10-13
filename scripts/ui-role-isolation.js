/**
 * ============================================================
 * 登录流程 + 角色界面隔离测试（小程序 H5 真机视口）
 * ------------------------------------------------------------
 * 验证「不同岗位进系统看到的入口不一样」——
 * 这是权限体系在界面上的直接体现，也是最容易被忽略的一层。
 *
 * 用法：node scripts/ui-role-isolation.js
 * ============================================================
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const H5 = process.env.H5_BASE || 'http://localhost:5199'
const LOCAL_API = process.env.LOCAL_API || 'http://127.0.0.1:3000'
const PROD_API = 'http://119.91.206.235:3000'
const OUT_DIR = path.join(__dirname, '..', '.tmp-local-audit')

let passed = 0, failed = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`) }
}

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
    req.write(payload); req.end()
  })
}

/** 页面首页上出现的角色入口 */
const CARD_SEL = {
  '出库员入口': '.role-card-out',
  '入库员入口': '.role-card-in',
  '采购员入口': '.role-card-purchase',
  '仓管入口': '.role-card-storekeeper',
  '老板入口': '.role-card-boss',
  '盘点入口': '.role-card-check'
}

async function main() {
  console.log('='.repeat(72))
  console.log('  登录流程 + 角色界面隔离测试')
  console.log('='.repeat(72))

  const browser = await chromium.launch({ executablePath: CHROME })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await page.route(`${PROD_API}/**`, async (route) => {
    await route.continue({ url: route.request().url().replace(PROD_API, LOCAL_API) })
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 150)))

  /**
   * 打开首页并读取角色入口
   *
   * ⚠️ 必须强制重新加载整页：小程序的用户状态是页面加载时从 storage 读进
   *    store 的，如果只在 SPA 内部切 hash，组件不会重新挂载，
   *    读到的会是**上一个身份的界面**（表现为结果整体错位一轮）。
   */
  const openHome = async () => {
    await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(300)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(3200)
    return page.evaluate((sel) => {
      const out = {}
      for (const [label, s] of Object.entries(sel)) out[label] = !!document.querySelector(s)
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ')
      return {
        cards: out,
        hasLoginBtn: /登录|授权|微信/.test(txt) && txt.length < 400,
        textLen: txt.length,
        head: txt.slice(0, 90)
      }
    }, CARD_SEL)
  }

  // ---------- 1. 未登录 ----------
  console.log('\n【场景 1】未登录状态进首页')
  await page.goto(H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    try { uni.removeStorageSync('sl_token'); uni.removeStorageSync('sl_user') } catch (e) {}
  })
  const anon = await openHome()
  console.log(`  页面内容：${anon.head}`)
  ok('未登录时不显示任何角色入口（不会泄露功能）',
    !Object.values(anon.cards).some(Boolean), JSON.stringify(anon.cards))
  ok('未登录时页面引导登录', anon.hasLoginBtn || anon.textLen < 400, `文字长度=${anon.textLen}`)

  // ---------- 2. 各角色登录后的入口 ----------
  const cases = [
    { openid: 'dev_out', title: '出库员', must: ['出库员入口'], mustNot: ['老板入口', '仓管入口'] },
    { openid: 'dev_in', title: '入库员', must: ['入库员入口'], mustNot: ['老板入口', '出库员入口'] },
    { openid: 'dev_purchase', title: '采购员', must: ['采购员入口'], mustNot: ['老板入口', '出库员入口'] },
    { openid: 'dev_sk', title: '仓管', must: ['仓管入口', '盘点入口'], mustNot: ['老板入口'] },
    { openid: 'dev_boss', title: '老板', must: ['老板入口'], mustNot: [] },
    { openid: 'dev_worker_01', title: '全能（多角色）', must: ['出库员入口', '入库员入口', '采购员入口', '仓管入口'], mustNot: [] }
  ]

  for (const c of cases) {
    console.log(`\n【场景 2】${c.title}（${c.openid}）登录后进首页`)
    const login = await apiCall('auth', 'login', { dev_openid: c.openid })
    if (!login.data?.token) { ok(`${c.title} 登录`, false, login.message); continue }
    await page.goto(H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(1200)
    await page.evaluate((p) => {
      uni.setStorageSync('sl_token', p.token)
      uni.setStorageSync('sl_user', p.user)
    }, { token: login.data.token, user: login.data.user })

    const home = await openHome()
    const shown = Object.entries(home.cards).filter(([, v]) => v).map(([k]) => k)
    console.log(`  可见入口：${shown.length ? shown.join('、') : '（无）'}`)

    for (const m of c.must) {
      ok(`${c.title} 能看到「${m}」`, home.cards[m], `实际：${shown.join('、') || '无'}`)
    }
    for (const n of c.mustNot) {
      ok(`${c.title} 看不到「${n}」（越权隔离）`, !home.cards[n], `实际：${shown.join('、')}`)
    }
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'screenshots', `role_${c.openid}.png`) })
    } catch (e) { /* ignore */ }
  }

  // ---------- 3. 权限被拒时的界面表现 ----------
  console.log('\n【场景 3】出库员直接手输老板页网址（越权访问）')
  const outLogin = await apiCall('auth', 'login', { dev_openid: 'dev_out' })
  await page.goto(H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(1200)
  await page.evaluate((p) => {
    uni.setStorageSync('sl_token', p.token); uni.setStorageSync('sl_user', p.user)
  }, { token: outLogin.data.token, user: outLogin.data.user })

  let bossApiFailed = false
  page.removeAllListeners('response')
  page.on('response', async (res) => {
    if (!res.url().includes('/api/')) return
    try {
      const b = await res.json()
      if (b && b.code === 403) bossApiFailed = true
    } catch (e) { /* ignore */ }
  })
  await page.goto(`${H5}/#/pages/boss/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3500)
  const bossView = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120))
  console.log(`  页面内容：${bossView}`)
  ok('出库员打开老板页时接口被拒（403）', bossApiFailed, '未观察到 403 响应')
  ok('出库员打开老板页不会崩（有可读提示或空白而非报错堆栈）',
    !/TypeError|undefined is not|Cannot read/.test(bossView), bossView)

  // ---------- 4. 登录页本身 ----------
  console.log('\n【场景 4】登录页')
  await page.goto(H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(1200)
  await page.evaluate(() => { try { uni.removeStorageSync('sl_token'); uni.removeStorageSync('sl_user') } catch (e) {} })
  await page.goto(`${H5}/#/pages/login/login`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3000)
  const loginPage = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ')
    return { len: txt.length, head: txt.slice(0, 120), btns: document.querySelectorAll('button, .btn, [class*=btn]').length }
  })
  console.log(`  登录页内容：${loginPage.head}`)
  ok('登录页可渲染', loginPage.len > 5, `长度 ${loginPage.len}`)
  ok('登录页有可点击按钮', loginPage.btns > 0, `按钮数 ${loginPage.btns}`)

  ok('全程无未捕获的运行时崩溃', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  await browser.close()

  console.log('\n' + '='.repeat(72))
  console.log(`  登录与角色隔离测试完成：通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length) {
    console.log('\n  失败明细：')
    failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`))
  }
  console.log('='.repeat(72))
  fs.writeFileSync(path.join(OUT_DIR, 'role-isolation-result.json'),
    JSON.stringify({ passed, failed, failures }, null, 2), 'utf8')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('异常：', e); process.exit(1) })
