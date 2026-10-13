/**
 * ============================================================
 * 岗位 Agent 测试命令 · UI 层（真实浏览器）
 * ------------------------------------------------------------
 * 用法：node tests/role-agent/ui-check.js
 *
 * 覆盖两端的真实渲染（接口层由 run.js 覆盖，这里专查「白屏 / 报错 / 数字对不上」）：
 *   1. 后台看板（admin/dist，Vue SPA，/admin）：登录 → 逐路由渲染检查 → 看板数字与接口比对
 *   2. 小程序 H5（miniprogram/dist/build/h5）：开发身份登录 → 关键页面渲染检查
 *
 * 依赖：playwright-core（托管工作区 @playwright/cli 自带），用本机 Edge（channel: msedge）
 * 输出：tests/role-agent/results/RA-ui-report-<时间戳>.md
 * ============================================================
 */
require('../../src/config/env')

const fs = require('fs')
const path = require('path')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { callRaw, loginAdmin, loginDev } = require('./lib')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5176/admin'
const H5_URL = process.env.H5_URL || 'http://127.0.0.1:5174'
const OUT_DIR = path.join(__dirname, 'results')

const results = []
function check(role, label, cond, level = 'P1', detail = '') {
  results.push({ role, label, pass: !!cond, level: cond ? '' : level, detail: String(detail || '') })
  return !!cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 收集控制台错误与 404 资源（过滤无关紧要的） */
function watchConsole(page, bucket) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const t = msg.text()
    if (/favicon|net::ERR_ABORTED.*\.(png|jpg|ico)|Download the React DevTools/i.test(t)) return
    bucket.push(t.slice(0, 300))
  })
  page.on('pageerror', (err) => bucket.push(`pageerror: ${String(err).slice(0, 300)}`))
  page.on('response', (r) => {
    if (r.status() < 400) return
    const u = r.url()
    if (/favicon/.test(u)) return
    bucket.push(`HTTP ${r.status()} ${u.slice(0, 200)}`)
  })
}

// ---------------- 后台看板 ----------------
async function checkAdmin(browser) {
  const role = '后台看板'
  const page = await browser.newPage()
  const errors = []
  watchConsole(page, errors)

  // 1. 登录
  await page.goto(ADMIN_URL, { waitUntil: 'networkidle' })
  await page.fill('input[placeholder="用户名"]', process.env.ADMIN_USERNAME || 'admin')
  await page.fill('input[placeholder="密码"]', process.env.ADMIN_PASSWORD || '123456')
  await page.click('button:has-text("登录")')
  await page.waitForTimeout(3000)

  const url = page.url()
  check(role, '登录后进入系统（不在登录页）', !url.includes('/login'), 'P0', `当前 ${url}`)

  // 2. 逐路由渲染检查
  const routes = [
    ['/dashboard', '工作台'],
    ['/stats/overview', '统计总览'],
    ['/material/list', '物料列表'],
    ['/order/outbound', '出库单'],
    ['/order/inbound', '入库单'],
    ['/order/purchase-tasks', '采购任务'],
    ['/message/list', '消息中心'],
    ['/check/list', '盘点列表'],
    ['/user/list', '用户管理'],
    ['/system/logs', '操作日志']
  ]
  for (const [route, name] of routes) {
    errors.length = 0
    await page.goto(`${ADMIN_URL}${route}`, { waitUntil: 'networkidle' }).catch((e) => errors.push(String(e)))
    await page.waitForTimeout(1200)
    const text = await page.evaluate(() => document.body.innerText || '')
    const has404 = /404|页面不存在|Not Found/i.test(text)
    check(role, `路由 ${name}(${route}) 渲染`, text.length > 100 && !has404, 'P1',
      `正文 ${text.length} 字${has404 ? '，出现404' : ''}`)
    check(role, `路由 ${name} 无控制台报错`, errors.length === 0, 'P1', errors.join(' | ').slice(0, 200))
  }

  // 3. 看板数字与接口比对（工作台回到第一屏读数）
  await page.goto(`${ADMIN_URL}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PASSWORD || '123456')
  const ov = await callRaw('stats', 'overview', {}, token)
  const apiWarning = ov && ov.data ? Number(ov.data.warning_count) : NaN
  const apiZero = ov && ov.data ? Number(ov.data.zero_count) : NaN
  const dashText = await page.evaluate(() => document.body.innerText || '')
  // 页面上应能找到与接口一致的预警数与零库存数（数字以文本形式出现在看板卡片里）
  check(role, '看板预警数与接口一致', dashText.includes(String(apiWarning)), 'P1',
    `接口 warning_count=${apiWarning}，页面${dashText.includes(String(apiWarning)) ? '有' : '没有'}该数字`)
  check(role, '看板零库存数与接口一致', dashText.includes(String(apiZero)), 'P1',
    `接口 zero_count=${apiZero}，页面${dashText.includes(String(apiZero)) ? '有' : '没有'}该数字`)

  await page.close()
}

// ---------------- 小程序 H5 ----------------
async function checkH5(browser) {
  const role = '小程序H5'

  /** 用指定身份登录，返回 page（addInitScript 在页面任何脚本跑之前注入身份，自动登录才会选中它） */
  async function loginAs(identityLabel, devOpenid) {
    const page = await browser.newPage()
    const errors = []
    watchConsole(page, errors)
    await page.addInitScript((openid) => {
      try {
        localStorage.setItem('sl_dev_openid', openid)
        localStorage.removeItem('sl_token')
      } catch (e) { /* ignore */ }
    }, devOpenid)
    await page.goto(`${H5_URL}/#/`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    const text = await page.evaluate(() => document.body.innerText || '')
    // 不同岗位首页条目数不同（老板只有 4 个入口，正文约 90 字；全能有 8 个），阈值不能按全能的写
    check(role, `以「${identityLabel}」身份进入首页`, text.length > 30, 'P0', `正文 ${text.length} 字`)
    check(role, `「${identityLabel}」首页显示该身份`, text.includes(identityLabel), 'P1',
      text.slice(0, 120).replace(/\n/g, ' '))
    return { page, errors }
  }

  // —— 老板 ——
  {
    const { page, errors } = await loginAs('老板', 'dev_boss')
    check(role, '老板首页无控制台报错', errors.length === 0, 'P1', errors.join(' | ').slice(0, 200))

    // 消息中心（盘点待审核通知的落点）。
    // ⚠️ 阈值别用「正文字数」：没有消息时是合法空态（只有标题+「暂无消息」十几个字），
    //    会被误判成「页面坏了」。判据认「页面骨架是否渲染出来」——有「消息」标题或空态文案 = 已挂载，
    //    白屏（crash）时正文几乎为空、也绝不含这些字。
    errors.length = 0
    await page.goto(`${H5_URL}/#/pages/message/list`, { waitUntil: 'networkidle' }).catch((e) => errors.push(String(e)))
    await page.waitForTimeout(1500)
    const msgText = await page.evaluate(() => document.body.innerText || '')
    check(role, '老板消息中心渲染（含空态）', /消息|暂无消息|未读/.test(msgText) && msgText.length > 5, 'P1',
      `正文 ${msgText.length} 字`)
    check(role, '消息中心无控制台报错', errors.length === 0, 'P1', errors.join(' | ').slice(0, 200))
    await page.close()
  }

  // —— 仓管 ——
  {
    const { page, errors } = await loginAs('仓管', 'dev_sk')
    check(role, '仓管首页无控制台报错', errors.length === 0, 'P1', errors.join(' | ').slice(0, 200))

    // 盘点列表（小程序侧盘点入口）。同理：没有盘点单时是合法空态，认骨架不认字数。
    errors.length = 0
    await page.goto(`${H5_URL}/#/pages/check/list`, { waitUntil: 'networkidle' }).catch((e) => errors.push(String(e)))
    await page.waitForTimeout(1500)
    const chkText = await page.evaluate(() => document.body.innerText || '')
    check(role, '仓管盘点列表渲染（含空态）', /盘点|新建盘点任务/.test(chkText) && chkText.length > 5, 'P1',
      `正文 ${chkText.length} 字`)
    check(role, '盘点列表无控制台报错', errors.length === 0, 'P1', errors.join(' | ').slice(0, 200))
    await page.close()
  }
}

// ---------------- 主流程 ----------------
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    await checkAdmin(browser)
    await checkH5(browser)
  } finally {
    await browser.close()
  }

  const fails = results.filter((r) => !r.pass)
  const lines = []
  lines.push(`# UI 层测试报告（真实浏览器）`)
  lines.push('')
  lines.push(`- 时间：${new Date().toLocaleString('zh-CN')}`)
  lines.push(`- 断言 ${results.length} 条，通过 ${results.length - fails.length}，失败 ${fails.length}`)
  lines.push(`- 结论：**${fails.length === 0 ? '干净' : '有问题'}**`)
  lines.push('')
  if (fails.length) {
    fails.forEach((r) => lines.push(`- [${r.level}][${r.role}] ${r.label}${r.detail ? ` —— ${r.detail}` : ''}`))
  } else {
    lines.push('全部断言通过 ✅')
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const p = path.join(OUT_DIR, `RA-ui-report-${stamp}.md`)
  fs.writeFileSync(p, lines.join('\n'), 'utf8')

  console.log(lines.join('\n'))
  console.log(`\n📄 报告：${p}`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('ui-check 崩溃：', e); process.exit(2) })
