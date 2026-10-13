/**
 * ============================================================
 * 后台「数据大屏」验收脚本（真实浏览器）
 * ------------------------------------------------------------
 * 干什么：
 *   用真浏览器以**老板**身份登录后台（关键：大屏只调老板有权限的接口，
 *   用老板跑一遍才能证明不会出现 403 白块），打开 /screen，
 *   逐块核对 KPI / 仓库总值 / 预警 / 排行榜 / 单据流水 / 库存流水是否渲染出数据，
 *   并截图存到 docs/screenshots。
 *
 * 前置：
 *   后端 3000、后台静态服务 5176 都在跑（Windows 计划任务）
 *
 * 运行：
 *   NODE_PATH=C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules \
 *     node scripts/verify-admin-screen.js
 *
 * 想验证「有数据时图表真的画得出来」（空库时单据/排行/绩效都是空态，看不出柱子对不对）：
 *   node scripts/_demo-screen-data.js          # 造 3 个 [RA-SCR] 物料 + 1 入库单 + 1 出库单
 *   node scripts/verify-admin-screen.js        # 截图会落在 docs/screenshots/
 *   cd server && node tests/cleanup-test-data.js --apply   # ⚠️ 务必清掉
 *
 * 可用环境变量覆盖：ADMIN_URL / VERIFY_USER / VERIFY_PASS
 * ============================================================
 */
const path = require('path')
const fs = require('fs')

function loadPlaywright() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    'playwright',
    process.env.PLAYWRIGHT_PATH,
    home && path.join(home, '.workbuddy/binaries/node/workspace/node_modules/playwright')
  ].filter(Boolean)
  for (const c of candidates) {
    try { return require(c) } catch (e) { /* 继续找 */ }
  }
  console.error('找不到 playwright。安装：cd "<隔离工作区>" && npm install playwright')
  process.exit(2)
}
const { chromium } = loadPlaywright()

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5176/admin'
const USERNAME = process.env.VERIFY_USER || 'wangzong'
const PASSWORD = process.env.VERIFY_PASS || 'wz123456'
const SHOT_DIR = path.resolve(__dirname, '../docs/screenshots')

async function launchBrowser() {
  if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH })
  try {
    return await chromium.launch()
  } catch (err) {
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    const dirs = fs.existsSync(base)
      ? fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse()
      : []
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-win64', 'chrome.exe')
      if (fs.existsSync(exe)) {
        console.log(`  (注) 使用本机已有内核：${d}`)
        return chromium.launch({ executablePath: exe })
      }
    }
    throw err
  }
}

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ' → ' + detail : ''}`) }
}

const txt = async (page, sel) => {
  const n = await page.locator(sel).count()
  return n ? (await page.locator(sel).first().innerText()).trim() : ''
}
const nonEmpty = async (page, sel) => {
  const n = await page.locator(sel).count()
  if (!n) return false
  for (let i = 0; i < n; i++) {
    const t = (await page.locator(sel).nth(i).innerText()).trim()
    if (!t) return false
  }
  return true
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await launchBrowser()
  // 大屏按 1920×1080 验收
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

  const consoleErrors = []
  const badResponses = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e && e.message)))
  // 记录 404/500 的**具体 URL**（控制台只给「404 Not Found」，看不出是哪个资源）
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`)
  })

  console.log('============================================================')
  console.log('  胜龙进销存 · 后台数据大屏验收（身份：老板）')
  console.log('============================================================')

  /* ---------- 1. 登录 ---------- */
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('用户名').fill(USERNAME)
  await page.getByPlaceholder('密码').fill(PASSWORD)
  await page.locator('.login-btn').click()
  await page.waitForFunction(() => !window.location.pathname.includes('/login'), null, { timeout: 20000 })
  console.log(`\n[1] 登录 ${USERNAME} → ${new URL(page.url()).pathname}`)
  check('老板成功登录后台', !page.url().includes('/login'))

  /* ---------- 2. 侧边栏有入口 ---------- */
  const menuText = await txt(page, '.sidebar-menu')
  check('侧边栏有「数据大屏」入口', menuText.includes('数据大屏'))

  /* ---------- 3. 打开大屏（走菜单点击，不是直接改地址） ---------- */
  await page.locator('.sidebar-menu .el-menu-item').filter({ hasText: '数据大屏' }).first().click()
  await page.waitForURL(/\/screen/, { timeout: 15000 })
  await page.waitForSelector('.kpi-val', { timeout: 15000 })
  // 等数据回填与图表绘制
  await page.waitForTimeout(4000)
  console.log(`\n[2] 已进入大屏：${new URL(page.url()).pathname}`)
  check('路由跳到 /screen（Layout 之外的全屏页）', page.url().includes('/screen'))

  /* ---------- 4. 报错条（关键：老板权限下不能有 403 白块） ---------- */
  const errBlocks = await page.locator('.scr-err').count()
  const errText = errBlocks ? (await page.locator('.scr-err').innerText()).trim() : ''
  check('顶部无「数据未能加载」报错条（老板权限内全部接口可用）', errBlocks === 0, errText)

  /* ---------- 5. KPI ---------- */
  console.log('\n[3] 顶部 KPI：')
  const kpiCount = await page.locator('.kpi').count()
  const kpiLabels = await page.locator('.kpi-label').allInnerTexts()
  const kpiVals = await page.locator('.kpi-val').allInnerTexts()
  kpiLabels.forEach((l, i) => console.log(`    ${l.padEnd(8, '　')} = ${kpiVals[i]}`))
  check('KPI 有 8 块', kpiCount === 8, `实际 ${kpiCount}`)
  check('KPI 全部有数字（无空白块）', await nonEmpty(page, '.kpi-val'))
  check('「库存总量」非 0 且有千分位', /[0-9]/.test(kpiVals[1] || '') && (kpiVals[1] || '').includes(','), kpiVals[1])
  check('「库存总值」带 ¥ 与「万/亿」单位', /¥/.test(kpiVals[2] || '') && /(万|亿)/.test(kpiVals[2] || ''), kpiVals[2])

  /* ---------- 6. 仓库总值面板 ---------- */
  console.log('\n[4] 仓库库存与总值：')
  const whRows = await page.locator('.wh-list li').count()
  const whText = await page.locator('.wh-list').innerText()
  console.log('    ' + whText.replace(/\n/g, ' | '))
  check('两个仓库都有明细（配件仓/成品仓）', whRows === 2 && whText.includes('配件仓') && whText.includes('成品仓'), `行数 ${whRows}`)
  check('仓库金额显示为「¥…万」', (whText.match(/¥[\d.]+ 万/g) || []).length >= 2)

  /* ---------- 7. 其它面板有内容或明确空态 ---------- */
  console.log('\n[5] 各面板内容：')
  const warnRows = await page.locator('.warn-list li:not(.empty-li)').count()
  const warnEmpty = await page.locator('.warn-list .empty-li').count()
  console.log(`    库存预警：${warnRows} 行${warnEmpty ? '（空态：暂无预警）' : ''}`)
  check('库存预警面板有内容或空态提示', warnRows > 0 || warnEmpty > 0)

  const valRows = await page.locator('.value-list li:not(.empty-li)').count()
  const valEmpty = await page.locator('.value-list .empty-li').count()
  const valFirst = valRows ? (await page.locator('.value-list li').first().innerText()).replace(/\n/g, ' ') : ''
  console.log(`    库存金额TOP10：${valRows} 行 ${valFirst ? '· 首行 ' + valFirst : ''}`)
  check('库存金额 TOP10 有真实数据', valRows > 0 && !valEmpty, `行数 ${valRows}`)

  const ordRows = await page.locator('.order-list li:not(.empty-li)').count()
  const ordEmpty = await page.locator('.order-list .empty-li').count()
  console.log(`    单据流水：${ordRows} 行${ordEmpty ? '（空态：暂无单据）' : ''}`)
  check('单据流水面板有内容或空态提示', ordRows > 0 || ordEmpty > 0)

  const opCanvas = await page.locator('.panel:has(.panel-t:text("人员绩效")) canvas').count()
  const opEmpty = await page.locator('.empty:text("近 30 天暂无操作记录")').count()
  console.log(`    人员绩效：${opCanvas ? '图表已绘制' : (opEmpty ? '空态' : '未渲染')}`)
  check('人员绩效面板有图表或空态', opCanvas > 0 || opEmpty > 0)

  /* ---------- 8. 库存流水滚动条 ---------- */
  const tkItems = await page.locator('.tk-item').count()
  const tkText = await txt(page, '.scr-ticker')
  console.log(`\n[6] 底部库存流水：${tkItems} 条`)
  console.log('    ' + tkText.replace(/\n/g, ' ').slice(0, 140))
  check('底部流水有内容或空态', tkItems > 0)
  check('流水内容是中文（非乱码）', !/[åÃâ]{2,}/.test(tkText), tkText.slice(0, 60))

  /* ---------- 9. 图表是否真的画出来了 ---------- */
  // 判据按数据来，别写死 canvas 数量：
  //   仓库有数据 → 饼图必然绘制；单据环节全为 0 时走空态文案、不画图
  const canvasCount = await page.locator('canvas').count()
  const stageEmpty = await page.locator('.empty:text("各环节均无待办单据")').count()
  console.log(`\n[7] 图表：${canvasCount} 个 canvas，单据环节${stageEmpty ? '走空态（全为 0）' : '已绘制'}`)
  check('仓库总值饼图已绘制', canvasCount >= 1, `canvas ${canvasCount}`)
  check('单据环节概览有图或有空态（不留坏图）', canvasCount >= 2 || stageEmpty > 0)

  /* ---------- 10. 无 JS 报错 ---------- */
  const realErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver|404 \(Not Found\)/i.test(e))
  console.log(`\n[8] 控制台错误：${realErrors.length} 条（另有 ${badResponses.length} 个 4xx/5xx 资源）`)
  realErrors.slice(0, 5).forEach((e) => console.log('    ! ' + e.slice(0, 160)))
  badResponses.slice(0, 5).forEach((e) => console.log('    ! ' + e.slice(0, 160)))
  check('无 JS 运行时报错', realErrors.length === 0)
  // 静默的 404 也算——只要不是站点图标
  const badAssets = badResponses.filter((u) => !/favicon/i.test(u))
  check('页面资源无 404/500（favicon 除外）', badAssets.length === 0, badAssets.join(' , '))

  /* ---------- 截图 ---------- */
  const shotFull = path.join(SHOT_DIR, 'admin-screen-1920.png')
  await page.screenshot({ path: shotFull })
  console.log(`\n📸 截图：${shotFull}`)

  // 顺带确认刷新按钮与返回后台可用
  await page.locator('.scr-btn').filter({ hasText: '刷新' }).first().click()
  await page.waitForTimeout(1500)
  check('点「刷新」后仍无报错条', (await page.locator('.scr-err').count()) === 0)

  await page.locator('.scr-btn').filter({ hasText: '返回后台' }).first().click()
  await page.waitForTimeout(1500)
  check('点「返回后台」回到 /dashboard', page.url().includes('/dashboard'), page.url())

  await browser.close()

  console.log('\n============================================================')
  console.log(`  结果：通过 ${pass} 项，失败 ${fail} 项`)
  console.log('============================================================')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
