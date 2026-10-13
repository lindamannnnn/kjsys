/**
 * ============================================================
 * 小程序 ⇄ Web 后台 数据连通性双向穿透验证
 * ------------------------------------------------------------
 * 回答一个问题：小程序里录的数据，后台看不看得到？后台改的，小程序看不看得到？
 *
 * 「配置相同」不等于「数据真通」，所以这里全程走真实界面操作：
 *   Part 1  在小程序 H5 界面上，真实提交一张入库单
 *   Part 2  在后台界面上，用供应商名搜出这张单 → 比对单号/金额
 *   Part 3  在后台界面上，点「确认」把单据确认掉
 *   Part 4  回小程序该单详情页 → 看状态是否变「已确认」
 *
 * 零污染生产：两端页面的 API 请求都在浏览器层重定向到本地 127.0.0.1:3000
 *
 * 用法：node scripts/ui-data-bridge.js
 * ============================================================
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const H5 = process.env.H5_BASE || 'http://localhost:5199'
const ADMIN = process.env.ADMIN_BASE || 'http://127.0.0.1:5173'
const LOCAL_API = process.env.LOCAL_API || 'http://127.0.0.1:3000'
const PROD_API = 'http://119.91.206.235:3000'
const ADMIN_DEV_API = 'http://localhost:3000'

const OUT_DIR = path.join(__dirname, '..', '.tmp-local-audit')
const SHOT_DIR = path.join(OUT_DIR, 'screenshots-bridge')
fs.mkdirSync(SHOT_DIR, { recursive: true })

let passed = 0, failed = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`) }
}
function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`) }

function apiCall(module, action, data, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ action, data })
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(`${LOCAL_API}/api/${module}`, { method: 'POST', headers, timeout: 20000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch (e) { resolve({ code: -999 }) } })
    })
    req.on('error', () => resolve({ code: -1 }))
    req.on('timeout', () => { req.destroy(); resolve({ code: -1 }) })
    req.write(payload); req.end()
  })
}

/** 从各种返回结构里挖出列表数组 */
function digList(res) {
  const d = res && res.data
  if (!d) return []
  if (Array.isArray(d)) return d
  for (const k of ['list', 'items', 'rows', 'records']) if (Array.isArray(d[k])) return d[k]
  return []
}
const idOf = (o) => o && (o._id ?? o.id)

/**
 * 给 uni-app H5 的输入框填值
 *
 * ⚠️ uni-app 的 <input placeholder="x"> 编译到 H5 后，
 *    placeholder **不是原生属性**，而是渲染成一个
 *    <div class="uni-input-placeholder">x</div>
 *    所以 `input[placeholder="x"]` 永远选不中，必须按这个 div 的文本反查。
 */
async function fillUni(page, placeholder, value) {
  const idx = await page.evaluate((ph) => {
    const list = Array.from(document.querySelectorAll('uni-input'))
    return list.findIndex((el) => {
      const d = el.querySelector('.uni-input-placeholder')
      return d && d.textContent.trim() === ph
    })
  }, placeholder)
  if (idx < 0) return false
  await page.locator('uni-input').nth(idx).locator('input').first().fill(String(value))
  return true
}

const STAMP = Date.now().toString().slice(-6)
const SUPPLIER = `桥接验证${STAMP}`
const QTY = 13
const PRICE = 88
const AMOUNT = QTY * PRICE

async function main() {
  console.log('='.repeat(74))
  console.log('  小程序 ⇄ Web 后台 · 数据连通性双向穿透验证')
  console.log(`  小程序端：${H5}`)
  console.log(`  后台端  ：${ADMIN}`)
  console.log(`  数据源  ：${LOCAL_API}（两端请求均在浏览器层重定向到本地，零污染生产）`)
  console.log('='.repeat(74))

  // ---------- Part 0 准备 ----------
  section('Part 0 · 准备（取身份与一个真实物料）')
  const boss = await apiCall('auth', 'login', { dev_openid: 'dev_boss' })
  const purchase = await apiCall('auth', 'login', { dev_openid: 'dev_purchase' })
  const bossToken = boss.data?.token
  if (!bossToken || !purchase.data?.token) {
    console.error('登录失败，请先 cd server && npm run seed:dev')
    process.exit(1)
  }
  const matRes = await apiCall('material', 'list', { page: 1, pageSize: 10 }, bossToken)
  const mats = digList(matRes)
  const material = mats[0]
  if (!material) { console.error('本地库里没有物料，无法继续'); process.exit(1) }
  console.log(`  物料：${material.name}（库存 ${material.current_stock ?? '?'} ${material.unit || ''}）`)
  console.log(`  本次标记供应商：${SUPPLIER}｜数量 ${QTY} × 单价 ${PRICE} = ${AMOUNT}`)

  const browser = await chromium.launch({ executablePath: CHROME })

  // ================= Part 1：小程序界面录单 =================
  section('Part 1 · 小程序界面上真实提交一张入库单')

  const miniCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await miniCtx.newPage()
  await page.route(`${PROD_API}/**`, async (route) => {
    await route.continue({ url: route.request().url().replace(PROD_API, LOCAL_API) })
  })
  const miniApi = []
  page.on('request', (r) => { if (r.url().includes('/api/')) miniApi.push(r.url().split('/api/')[1]) })
  const miniErrors = []
  page.on('pageerror', (e) => miniErrors.push(String(e.message).slice(0, 150)))

  // 注入采购员身份
  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.evaluate((p) => {
    uni.setStorageSync('sl_token', p.token)
    uni.setStorageSync('sl_user', p.user)
  }, { token: purchase.data.token, user: purchase.data.user })

  await page.goto(`${H5}/#/pages/in/submit`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3500)

  await page.waitForSelector('.material-item', { timeout: 25000 })
  const allCount = await page.locator('.material-item').count()
  ok('小程序：物料列表已加载', allCount > 0, `共 ${allCount} 个`)

  const target = page.locator('.material-item', { hasText: material.name }).first()
  const targetCount = await target.count()
  ok('小程序：列表里找到目标物料', targetCount > 0, material.name)
  if (targetCount === 0) {
    await browser.close()
    return report()
  }
  await target.click()
  await page.waitForTimeout(1500)
  const panelUp = await page.locator('.submit-panel').isVisible().catch(() => false)
  ok('小程序：点选物料后弹出提交面板', panelUp)

  const fQty = await fillUni(page, '请输入数量', QTY)
  const fPrice = await fillUni(page, '请输入单价', PRICE)
  const fSup = await fillUni(page, '请输入供应商名称', SUPPLIER)
  ok('小程序：数量/单价/供应商三个输入框都能填', fQty && fPrice && fSup,
    `数量=${fQty} 单价=${fPrice} 供应商=${fSup}`)
  await page.waitForTimeout(800)

  const totalTxt = (await page.locator('.total-price').innerText().catch(() => '')).replace(/\s/g, '')
  ok(`小程序：小计自动算出 ${AMOUNT}`, totalTxt.includes(String(AMOUNT)), `页面显示 ${totalTxt}`)

  await page.screenshot({ path: path.join(SHOT_DIR, '1-mini-filled.png') })
  await page.click('.btn-submit')
  await page.waitForTimeout(5000)
  await page.screenshot({ path: path.join(SHOT_DIR, '2-mini-after-submit.png') })

  ok('小程序：提交过程无页面报错', miniErrors.length === 0, miniErrors.join(' | '))

  // 库里是否真的落了这单
  const inList = await apiCall('inbound', 'list', { page: 1, pageSize: 30 }, bossToken)
  const orders = digList(inList)
  const created = orders.find((o) => String(o.supplier || '').includes(STAMP))
  ok('→ 后端库里出现了这张入库单（小程序写入已落库）', !!created,
    created ? `单号 ${created.order_no}` : `最近 ${orders.length} 单里没有`)

  if (!created) {
    console.log('\n  小程序端 API 调用记录：')
    miniApi.slice(-10).forEach((u) => console.log('    ·', u))
    await browser.close()
    return report()
  }
  const orderId = idOf(created)
  const orderNo = created.order_no
  console.log(`  单号 ${orderNo}｜状态 ${created.status}｜金额 ${created.total_price}`)

  // 确认前先看一眼详情页：此时应【没有】审批信息区块（后面用它做对照）
  await page.goto(`${H5}/#/pages/in/detail?id=${orderId}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3500)
  const beforeTxt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  await page.screenshot({ path: path.join(SHOT_DIR, '2b-mini-detail-pending.png'), fullPage: true })
  ok('小程序详情页（确认前）：显示的是这张单', beforeTxt.includes(orderNo), orderNo)
  ok('小程序详情页（确认前）：还没有「审批信息」区块（作为对照基线）',
    !beforeTxt.includes('审批信息'), beforeTxt.slice(0, 110))

  // ================= Part 2：后台界面查这单 =================
  section('Part 2 · 后台界面上搜出这张单')

  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const ap = await adminCtx.newPage()
  await ap.route(`${ADMIN_DEV_API}/**`, async (route) => {
    await route.continue({ url: route.request().url().replace(ADMIN_DEV_API, LOCAL_API) })
  })
  const adminErrors = []
  ap.on('pageerror', (e) => adminErrors.push(String(e.message).slice(0, 150)))

  await ap.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await ap.waitForTimeout(3500)
  const inputs = await ap.$$('input')
  await inputs[0].fill('admin')
  await inputs[1].fill('123456')
  const loginBtns = await ap.$$('button')
  await loginBtns[loginBtns.length - 1].click()
  await ap.waitForTimeout(5000)

  await ap.goto(`${ADMIN}/order/inbound`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await ap.waitForTimeout(4500)

  const SUP = 'input[placeholder="搜索供应商"]'
  await ap.waitForSelector(SUP, { timeout: 20000 })
  await ap.fill(SUP, SUPPLIER)
  await ap.click('button:has-text("搜索")')
  await ap.waitForTimeout(3500)
  await ap.screenshot({ path: path.join(SHOT_DIR, '3-admin-search.png'), fullPage: true })

  const rows = await ap.$$eval('.el-table__row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
  const hitRow = rows.find((r) => r.includes(SUPPLIER))
  ok('后台：用供应商名搜到了小程序刚提交的单', !!hitRow, hitRow || `表格 ${rows.length} 行，未命中`)
  ok('后台：单号与小程序提交的一致', !!hitRow && hitRow.includes(orderNo), `期望 ${orderNo}`)
  ok(`后台：总金额一致（${QTY}×${PRICE}=${AMOUNT}）`, !!hitRow && hitRow.includes(String(AMOUNT)),
    hitRow ? hitRow.slice(0, 100) : '')

  // ================= Part 3：后台界面确认 =================
  section('Part 3 · 后台界面上点「确认」')

  const rowLoc = ap.locator('.el-table__row', { hasText: SUPPLIER }).first()
  const confirmBtn = rowLoc.locator('button:has-text("确认")').first()
  const canConfirm = await confirmBtn.count()
  ok('后台：待确认单据上出现「确认」按钮', canConfirm > 0)

  if (canConfirm > 0) {
    await confirmBtn.click()
    await ap.waitForTimeout(1500)
    const boxBtn = ap.locator('.el-message-box__btns button.el-button--primary').first()
    if (await boxBtn.count()) {
      await boxBtn.click()
      await ap.waitForTimeout(4000)
    }
    await ap.screenshot({ path: path.join(SHOT_DIR, '4-admin-confirmed.png'), fullPage: true })
  }

  await ap.waitForTimeout(1500)
  const inList2 = await apiCall('inbound', 'list', { page: 1, pageSize: 30 }, bossToken)
  const after = digList(inList2).find((o) => o.order_no === orderNo)
  ok('→ 后台确认后，库里单据状态变为 confirmed', after && after.status === 'confirmed',
    after ? `status=${after.status}` : '没查到该单')
  ok('后台：操作过程无页面报错', adminErrors.length === 0, adminErrors.join(' | '))

  // ================= Part 4：回小程序看状态 =================
  section('Part 4 · 回小程序看这张单的状态')

  await page.goto(`${H5}/#/pages/in/detail?id=${orderId}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: path.join(SHOT_DIR, '5-mini-detail-after.png'), fullPage: true })

  const detailTxt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  ok('小程序详情页：显示的是这张单（单号一致）', detailTxt.includes(orderNo), orderNo)
  ok('小程序详情页（确认后）：出现了「审批信息」区块（确认前没有）',
    detailTxt.includes('审批信息'), detailTxt.slice(0, 140))
  ok('小程序详情页：确认人与确认时间都已显示（后台操作的痕迹传到了小程序）',
    /系统管理员|开发·仓管|admin/.test(detailTxt) && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(detailTxt),
    detailTxt.slice(0, 200))

  // ================= Part 5：同一物料的库存，两端是不是同一个数 =================
  section('Part 5 · 同一物料的库存，两端读到的数字是否一致')

  // 后台：物料列表页读出「当前库存」
  await ap.goto(`${ADMIN}/material/list`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await ap.waitForTimeout(4500)
  await ap.fill('input[placeholder^="搜索名称"]', material.name)
  await ap.click('button:has-text("搜索")')
  await ap.waitForTimeout(3500)
  await ap.screenshot({ path: path.join(SHOT_DIR, '6-admin-material-stock.png'), fullPage: true })

  const adminStock = await ap.evaluate((name) => {
    const heads = Array.from(document.querySelectorAll('.el-table__header th')).map((e) => e.innerText.trim())
    const ci = heads.indexOf('当前库存')
    const rows = Array.from(document.querySelectorAll('.el-table__body .el-table__row'))
    const row = rows.find((r) => r.innerText.includes(name))
    if (!row || ci < 0) return null
    const tds = Array.from(row.querySelectorAll('td'))
    return tds[ci] ? tds[ci].innerText.trim() : null
  }, material.name)
  ok('后台：物料列表页读到该物料的当前库存', adminStock !== null && adminStock !== '',
    `后台显示「${adminStock}」`)

  // 小程序：入库提交页读出同一个物料的库存
  await page.goto(`${H5}/#/pages/in/submit`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(4000)
  const miniItemTxt = await page.locator('.material-item', { hasText: material.name }).first().innerText().catch(() => '')
  const miniStock = (miniItemTxt.match(/库存[:：]\s*([\d.]+)/) || [])[1]
  await page.screenshot({ path: path.join(SHOT_DIR, '7-mini-material-stock.png') })
  ok('小程序：入库页读到该物料的库存', !!miniStock, `小程序显示「${miniStock}」`)

  ok('→ 两端读到的库存是同一个数（同一份数据，不是两套）',
    !!adminStock && !!miniStock && String(adminStock).replace(/[^\d.]/g, '') === String(miniStock),
    `后台 ${adminStock} vs 小程序 ${miniStock}`)

  await browser.close()
  report()
}

function report() {
  console.log(`\n${'='.repeat(74)}`)
  console.log(`  结果：通过 ${passed} ｜ 失败 ${failed}`)
  console.log(`  截图：${SHOT_DIR}`)
  if (failures.length) {
    console.log('\n  失败明细：')
    failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`))
  }
  console.log('='.repeat(74))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(1) })
