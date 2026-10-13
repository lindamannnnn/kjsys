/**
 * ============================================================
 * 复现 / 验证：仓管工作台「待确认」红点，确认后不消失
 * ------------------------------------------------------------
 * 真实路径（关键：全程不重新打开工作台，否则重挂载会掩盖问题）：
 *   1. 造一张待确认入库单
 *   2. 首次进入工作台        → 读红点 N1
 *   3. 点「待确认单据」卡片   → 进入 pending 页（navigateTo，工作台留在栈里）
 *   4. 点「确认」→ 弹窗确认   → 数据真的变了
 *   5. 返回工作台（不 reload）→ 读红点 N2
 *
 * 判定：
 *   · 后端待确认数确实 -1      → 证明接口和数据都对
 *   · 工作台红点 == 后端新值   → 修复后应通过；修复前会显示旧值（即用户报的红点不消失）
 *
 * 用法：node scripts/ui-repro-badge.js
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
const SHOT_DIR = path.join(__dirname, '..', '.tmp-local-audit', 'screenshots-badge')
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
function digList(res) {
  const d = res && res.data
  if (!d) return []
  if (Array.isArray(d)) return d
  for (const k of ['list', 'items', 'rows']) if (Array.isArray(d[k])) return d[k]
  return []
}
const idOf = (o) => o && (o._id ?? o.id)

async function main() {
  console.log('='.repeat(74))
  console.log('  复现/验证：仓管工作台「待确认」红点，确认后是否消失')
  console.log('='.repeat(74))

  const sk = await apiCall('auth', 'login', { dev_openid: 'dev_sk' })
  const purchase = await apiCall('auth', 'login', { dev_openid: 'dev_purchase' })
  const boss = await apiCall('auth', 'login', { dev_openid: 'dev_boss' })
  const skToken = sk.data?.token, purchaseToken = purchase.data?.token, bossToken = boss.data?.token
  if (!skToken || !purchaseToken) { console.error('登录失败，请先 cd server && npm run seed:dev'); process.exit(1) }

  // ---------- 1. 造一张待确认入库单 ----------
  section('准备 · 造一张待确认入库单')
  const mats = digList(await apiCall('material', 'list', { page: 1, pageSize: 5 }, bossToken))
  const material = mats[0]
  if (!material) { console.error('本地库无物料'); process.exit(1) }

  const stamp = Date.now().toString().slice(-6)
  const sub = await apiCall('inbound', 'submit', {
    items: [{ material_id: idOf(material), quantity: 5, unit_price: 10, material_name: material.name, unit: material.unit }],
    supplier: `红点复现${stamp}`,
    remark: `红点复现${stamp}`,
    warehouse_id: 'peijian',
    type: 'purchase'
  }, purchaseToken)
  ok('造单成功（待确认）', sub.code === 0 && sub.data?._id, sub.message || `id=${idOf(sub.data)}`)
  if (sub.code !== 0) { process.exit(1) }
  const targetNo = sub.data.order_no
  console.log(`  新单：${targetNo}`)

  const countBackend = async () => {
    const [o, i] = await Promise.all([
      apiCall('outbound', 'pendingCount', {}, skToken),
      apiCall('inbound', 'pendingCount', {}, skToken)
    ])
    return (o.data?.count || 0) + (i.data?.count || 0)
  }

  const browser = await chromium.launch({ executablePath: CHROME })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await page.route(`${PROD_API}/**`, async (r) => {
    await r.continue({ url: r.request().url().replace(PROD_API, LOCAL_API) })
  })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 150)))

  // 注入仓管身份
  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.evaluate((p) => {
    uni.setStorageSync('sl_token', p.token)
    uni.setStorageSync('sl_user', p.user)
  }, { token: skToken, user: sk.data.user })

  const readDash = () => page.evaluate(() => {
    const badge = document.querySelector('.badge')
    return {
      badge: badge ? badge.textContent.trim() : '0',
      statValues: Array.from(document.querySelectorAll('.stat-value')).map((e) => e.textContent.trim()),
      firstOrder: (document.querySelector('.order-item') || {}).innerText
    }
  })

  // ---------- 2. 首次进入工作台 ----------
  section('步骤 1 · 首次进入工作台（页面正常挂载）')
  await page.goto(`${H5}/#/pages/storekeeper/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(4500)
  const s1 = await readDash()
  const back1 = await countBackend()
  await page.screenshot({ path: path.join(SHOT_DIR, '1-dashboard-before.png') })
  console.log(`  工作台红点=${s1.badge}｜顶部统计=${JSON.stringify(s1.statValues)}｜后端待确认=${back1}`)
  ok('工作台红点与后端待确认数一致（初始状态正确）', s1.badge === String(back1),
    `页面 ${s1.badge} vs 后端 ${back1}`)

  // ---------- 3. 点进待确认页 ----------
  section('步骤 2 · 点「待确认单据」进入列表页')
  await page.locator('text=待确认单据').first().click()
  await page.waitForTimeout(4000)
  const pendingUrl = page.url()
  ok('已进入待确认列表页', /storekeeper\/pending/.test(pendingUrl), pendingUrl)
  await page.screenshot({ path: path.join(SHOT_DIR, '2-pending-list.png') })

  const beforeCount = await page.locator('.btn-confirm').count()
  ok('待确认列表里有可确认的单据', beforeCount > 0, `${beforeCount} 个确认按钮`)

  // ---------- 4. 确认一张 ----------
  section('步骤 3 · 点「确认」并确认弹窗')
  await page.locator('.btn-confirm').first().click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(SHOT_DIR, '3-modal.png') })

  const okBtn = page.locator('.uni-modal__btn_primary')
  const okCount = await okBtn.count()
  ok('弹出确认框', okCount > 0)
  if (okCount > 0) {
    await okBtn.first().click()
    await page.waitForTimeout(4000)
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '4-after-confirm.png') })

  const back2 = await countBackend()
  ok('→ 后端待确认数确实 -1（接口与数据是对的）', back2 === back1 - 1, `${back1} → ${back2}`)

  // ---------- 5. 返回工作台（不重载） ----------
  section('步骤 4 · 返回工作台（不重载页面，模拟真实返回）')
  await page.goBack()
  await page.waitForTimeout(4000)
  const afterUrl = page.url()
  ok('已回到工作台', /storekeeper\/dashboard/.test(afterUrl), afterUrl)

  const s2 = await readDash()
  await page.screenshot({ path: path.join(SHOT_DIR, '5-dashboard-after-back.png') })
  console.log(`  工作台红点=${s2.badge}｜顶部统计=${JSON.stringify(s2.statValues)}｜后端待确认=${back2}`)

  ok('✅ 返回工作台后，红点已按最新数据刷新', s2.badge === String(back2),
    `页面还显示 ${s2.badge}，后端其实已经是 ${back2}`)
  ok('✅ 顶部「待确认」统计数字也已刷新',
    (s2.statValues[0] || '') === String(back2), `页面 ${s2.statValues[0]} vs 后端 ${back2}`)
  ok('运行过程无页面报错', errs.length === 0, errs.join(' | '))

  await browser.close()

  console.log(`\n${'='.repeat(74)}`)
  console.log(`  结果：通过 ${passed} ｜ 失败 ${failed}`)
  console.log(`  截图：${SHOT_DIR}`)
  if (failures.length) { console.log('\n  失败明细：'); failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`)) }
  console.log('='.repeat(74))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(1) })
