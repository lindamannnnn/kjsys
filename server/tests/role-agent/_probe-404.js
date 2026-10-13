/**
 * 一次性探针：把后台页面加载期间**所有** 4xx/5xx 响应与 console 报错连 URL 一起打出来。
 *
 * 起因：batch2-admin-ui-check.js 的「全程没有 JS 报错」红了，文本是
 *   「Failed to load resource: the server responded with a status of 404 (Not Found)」，
 *   而 `console` 文本里**不带 URL**，无法判断是谁 404。
 * 本探针同时挂 `response` 与 `requestfailed`，并打印 console 的 location，
 * 用证据说话再决定是改判据还是修问题。
 *
 * 用法（静态服务和用例必须同一条 Bash 命令）：
 *   cd server
 *   node tests/role-agent/static-serve.js ../admin/dist-local 5178 admin & sleep 2; \
 *     ADMIN_URL=http://127.0.0.1:5178/admin node tests/role-agent/_probe-404.js; kill %1
 *
 * 自建一个临时管理员账号（RA_PROBE_admin），跑完删掉。
 */
require('../../src/config/env')

const bcrypt = require('bcryptjs')
let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { query, execute } = require('../../src/db/pool')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5178/admin'
const USER = 'RA_PROBE_admin'
const PASS = 'RA_Probe_Pwd_2026'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await execute(`DELETE FROM users WHERE username = ?`, [USER])
  const hash = await bcrypt.hash(PASS, 10)
  await execute(
    `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
     VALUES (?, ?, '测试·探针管理员', ?, '[]', 'active', 0, NOW())`,
    [USER, hash, JSON.stringify(['admin'])]
  )

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

  const hits = []
  page.on('response', (res) => {
    if (res.status() >= 400) hits.push(`[${res.status()}] ${res.request().method()} ${res.url()}`)
  })
  page.on('requestfailed', (req) => {
    hits.push(`[FAILED] ${req.method()} ${req.url()} :: ${req.failure() && req.failure().errorText}`)
  })
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    let loc = ''
    try { loc = JSON.stringify(m.location()) } catch (e) { loc = '(取不到)' }
    console.log(`  console.error: ${m.text()}\n      location: ${loc}`)
  })

  console.log('== 打开登录页 ==')
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await sleep(1500)

  console.log('== 登录 ==')
  await page.fill('input[placeholder="用户名"]', USER)
  await page.fill('input[placeholder="密码"]', PASS)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(2000)
  console.log(`  落地：${page.url()}`)

  console.log('== 逛一遍物料列表 ==')
  await page.goto(`${ADMIN_URL}/material/list`, { waitUntil: 'domcontentloaded' })
  await sleep(2000)

  // 对照实验：主动发一个必然 404 的请求，看 page.on('response') 到底抓不抓得到。
  // 如果抓不到，那 batch2-admin-ui-check 里「全程没有 404 请求」这条断言就是恒绿的假信号。
  console.log('== 对照：主动请求一个不存在的资源 ==')
  const before = hits.length
  await page.evaluate(async (url) => {
    try { await fetch(url) } catch (e) { /* 404 不是异常，只有网络错才是 */ }
  }, `${ADMIN_URL}/no-such-asset-xyz.png`).catch(() => {})
  await sleep(800)
  console.log(`  主动造 404 后，新增捕获 ${hits.length - before} 条 → ${hits.length > before ? '探针有效' : '⚠️ 探针抓不到，断言是假信号'}`)

  console.log('\n== 4xx/5xx 与失败请求清单 ==')
  if (!hits.length) console.log('  （无）')
  hits.forEach((h) => console.log(`  ${h}`))

  await browser.close()
  await execute(`DELETE FROM users WHERE username = ?`, [USER])
  console.log('\n（探针账号已删）')
  process.exit(0)
})().catch(async (e) => {
  console.error('探针崩了：', e)
  try { await execute(`DELETE FROM users WHERE username = ?`, ['RA_PROBE_admin']) } catch (err) { /* 忽略 */ }
  process.exit(1)
})
