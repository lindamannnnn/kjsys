/**
 * ============================================================
 * 后台「物料按仓库分开」验收脚本（真实浏览器）
 * ------------------------------------------------------------
 * 干什么：
 *   用真浏览器登录后台，点左侧「配件仓物料 / 成品仓物料」两个入口，
 *   核对地址、仓库锁定标签、列表条数、仓库列是否隐藏。
 *
 * 前置：
 *   后端 http://localhost:3000 与后台 http://localhost:5173 都已在跑
 *
 * 运行（playwright 装在隔离工作区，需指定 NODE_PATH）：
 *   NODE_PATH=C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules \
 *     node scripts/verify-admin-warehouse-split.js
 *
 * 说明：
 *   默认用 wangzong（老板，无需改密）登录，避免触发 admin 的「必须改密」拦截。
 *   可用环境变量 VERIFY_USER / VERIFY_PASS 覆盖。
 * ============================================================
 */
const path = require('path')
const fs = require('fs')

/**
 * 加载 playwright。
 * playwright 属于「只在验收时才用」的重依赖，没装进项目里，
 * 而是装在隔离工作区，所以这里按几个位置依次找。
 */
function loadPlaywright() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    'playwright',
    process.env.PLAYWRIGHT_PATH,
    home && path.join(home, '.workbuddy/binaries/node/workspace/node_modules/playwright')
  ].filter(Boolean)

  for (const c of candidates) {
    try {
      return require(c)
    } catch (e) {
      /* 继续找下一个 */
    }
  }
  console.error('找不到 playwright。安装方式：')
  console.error('  cd "<隔离工作区>" && npm install playwright')
  console.error('或用 PLAYWRIGHT_PATH 指定路径后重试。')
  process.exit(2)
}

const { chromium } = loadPlaywright()

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:5173'
const USERNAME = process.env.VERIFY_USER || 'wangzong'
const PASSWORD = process.env.VERIFY_PASS || 'wz123456'

const SHOT_DIR = path.resolve(__dirname, '../docs/screenshots')

/**
 * 期望值来自数据库实测：配件仓 1759 / 成品仓 147（150 条扣掉 3 条车间标题行）/ 合计 1909
 * subLabel   —— 细分类在这一页叫什么（跟着仓库变）
 * subPick    —— 要点选的那个细分类
 * subTotal   —— 选中后应有的条数
 */
const CASES = [
  {
    name: '配件仓物料',
    path: '/material/parts',
    warehouse: '配件仓',
    expectTotal: 1759,
    subLabel: '编号分类',
    subPick: 'B004 阀件铜件',
    subTotal: 199,
    hasNoColumn: true
  },
  {
    name: '成品仓物料',
    path: '/material/product',
    warehouse: '成品仓',
    expectTotal: 147,
    subLabel: '车间',
    subPick: '西厨车间',
    subTotal: 38,
    hasNoColumn: false
  }
]

let pass = 0
let fail = 0

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  [OK] ${label}`)
  } else {
    fail++
    console.log(`  [FAIL] ${label}${detail ? ' → ' + detail : ''}`)
  }
}

/** 读分页组件里的「共 N 条」 */
async function readTotal(page) {
  const el = page.locator('.el-pagination__total')
  if ((await el.count()) === 0) return null
  const text = (await el.first().innerText()).trim()
  const m = text.match(/(\d[\d,]*)/)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

/**
 * 启动浏览器。
 * playwright 自带内核版本对不上时会报「Executable doesn't exist」，
 * 这里兜底用本机 ms-playwright 缓存里已经下载好的 chromium。
 */
async function launchBrowser() {
  if (process.env.CHROME_PATH) {
    return chromium.launch({ executablePath: process.env.CHROME_PATH })
  }
  try {
    return await chromium.launch()
  } catch (err) {
    const base = path.join(
      process.env.LOCALAPPDATA || '',
      'ms-playwright'
    )
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

/**
 * 在搜索栏里按标签名找到那个下拉、选中指定项、再点「搜索」
 * （细分类下拉的标签名会跟着仓库变，所以按 label 定位）
 */
async function pickSelectByLabel(page, label, value) {
  const item = page.locator('.search-card .el-form-item').filter({ hasText: label }).first()
  await item.locator('.el-select').first().click()
  await page.waitForTimeout(500)
  await page.locator('.el-select-dropdown__item:visible').filter({ hasText: value }).first().click()
  await page.waitForTimeout(400)
  await page.locator('.search-card button').filter({ hasText: '搜索' }).first().click()
  await page.waitForTimeout(1300)
}

/** 判断表头里有没有某一列 */
async function hasColumn(page, title) {
  const n = await page
    .locator('.el-table__header th')
    .filter({ hasText: new RegExp(`^${title}$`) })
    .count()
  return n > 0
}

/** 确保「物料管理」子菜单是展开的 */
async function ensureMenuOpen(page) {
  const sub = page.locator('.sidebar-menu .el-sub-menu__title').filter({ hasText: '物料管理' })
  const opened = await sub.first().evaluate((el) =>
    el.closest('.el-sub-menu').classList.contains('is-opened')
  )
  if (!opened) {
    await sub.first().click()
    await page.waitForTimeout(400)
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  console.log('============================================================')
  console.log('  胜龙进销存 · 后台物料分仓验收')
  console.log('============================================================')

  /* ---------------- 1. 登录 ---------------- */
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('用户名').fill(USERNAME)
  await page.getByPlaceholder('密码').fill(PASSWORD)
  await page.locator('.login-btn').click()
  await page.waitForFunction(
    () => !window.location.pathname.includes('/login'),
    null,
    { timeout: 15000 }
  )

  console.log(`\n[1] 登录 ${USERNAME} → ${new URL(page.url()).pathname}`)
  check('登录成功进入后台', !page.url().includes('/login'))

  /* ---------------- 2. 菜单入口 ---------------- */
  await ensureMenuOpen(page)
  const menuText = await page.locator('.sidebar-menu').innerText()
  const lines = menuText.split('\n').map((s) => s.trim()).filter(Boolean)
  console.log('\n[2] 左侧「物料管理」下的菜单项：')
  const subItems = lines.slice(lines.indexOf('物料管理') + 1)
  console.log('    ' + subItems.join('  |  '))

  check('有「配件仓物料」入口', menuText.includes('配件仓物料'))
  check('有「成品仓物料」入口', menuText.includes('成品仓物料'))
  check('不再有含混的单独「物料列表」入口', !subItems.includes('物料列表'))

  /* ---------------- 3. 逐个仓库入口 ---------------- */
  for (const c of CASES) {
    console.log(`\n[3] 进入「${c.name}」`)
    await ensureMenuOpen(page)
    await page.locator('.sidebar-menu .el-menu-item').filter({ hasText: c.name }).first().click()
    await page.waitForURL(new RegExp(c.path.replace('/', '\\/')), { timeout: 8000 })
    await page.waitForTimeout(1300)

    check(`地址跳到 ${c.path}`, page.url().includes(c.path))

    const tag = page.locator('.wh-lock-tag')
    const tagText = (await tag.count()) ? (await tag.first().innerText()).trim() : ''
    check(`仓库锁定标签显示「${c.warehouse}」`, tagText === c.warehouse, `实际="${tagText}"`)

    const total = await readTotal(page)
    check(`列表条数 = ${c.expectTotal}`, total === c.expectTotal, `实际=${total}`)

    const whCol = await page.locator('.el-table__header th').filter({ hasText: '仓库' }).count()
    check('表格已隐藏「仓库」列', whCol === 0, `仍存在 ${whCol} 个`)

    const rows = await page.locator('.el-table__body tbody tr').count()
    check('表格里有数据行', rows > 0, `行数=${rows}`)

    /* --- 细分类 --- */
    const labelShown = await page
      .locator('.search-card .el-form-item')
      .filter({ hasText: c.subLabel })
      .count()
    check(`细分类下拉标签叫「${c.subLabel}」`, labelShown > 0)

    check(
      `表格${c.hasNoColumn ? '有' : '无'}「编号」列`,
      (await hasColumn(page, '编号')) === !!c.hasNoColumn
    )
    check(
      `表格有「${c.subLabel}」列`,
      await hasColumn(page, c.subLabel)
    )

    await pickSelectByLabel(page, c.subLabel, c.subPick)
    const subTotal = await readTotal(page)
    check(`筛选「${c.subPick}」= ${c.subTotal} 条`, subTotal === c.subTotal, `实际=${subTotal}`)

    // 确认筛出来的行确实都属于这个细分类
    // 列顺序：配件仓 = 编号/名称/规格/分类/编号分类，成品仓 = 名称/规格/分类/车间
    const subColIndex = c.hasNoColumn ? 4 : 3
    const cellTexts = await page
      .locator('.el-table__body tbody tr')
      .first()
      .locator('td')
      .nth(subColIndex)
      .innerText()
      .catch(() => '')
    check(
      `筛出的行细分类为「${c.subPick}」`,
      cellTexts.includes(c.subPick),
      `首行内容="${cellTexts}"`
    )

    const shot = path.join(SHOT_DIR, `admin-${c.path.split('/').pop()}.png`)
    await page.screenshot({ path: shot })
    console.log(`  (截图) ${shot}`)
  }

  /* ---------------- 3.5 按编号搜索（配件仓） ---------------- */
  console.log('\n[3.5] 配件仓按编号搜索 A001-7')
  await ensureMenuOpen(page)
  await page.locator('.sidebar-menu .el-menu-item').filter({ hasText: '配件仓物料' }).first().click()
  await page.waitForURL(/\/material\/parts/, { timeout: 8000 })
  await page.waitForTimeout(1000)
  await page.locator('.search-card input').first().fill('A001-7')
  await page.locator('.search-card button').filter({ hasText: '搜索' }).first().click()
  await page.waitForTimeout(1300)
  const noTotal = await readTotal(page)
  check('按编号 A001-7 能搜到 1 条', noTotal === 1, `实际=${noTotal}`)
  const noCell = await page.locator('.el-table__body tbody tr td').first().innerText()
  check('搜到的确实是 A001-7', noCell.includes('A001-7'), `实际="${noCell}"`)

  /* ---------------- 4. 全部物料入口仍然可用 ---------------- */
  console.log('\n[4] 直接访问 /material/list（数据看板预警跳转用的入口）')
  await page.goto(`${ADMIN_URL}/material/list`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1300)
  // 1759（配件仓）+ 147（成品仓，已隐藏 3 条车间标题行）= 1906
  const allTotal = await readTotal(page)
  check('不锁仓时仍能看全部 1906 条', allTotal === 1906, `实际=${allTotal}`)
  const lockTag = await page.locator('.wh-lock-tag').count()
  check('不锁仓时不显示仓库标签', lockTag === 0, `标签数=${lockTag}`)
  const selects = await page.locator('.search-card .el-select').count()
  check('不锁仓时保留仓库下拉', selects >= 2, `下拉数=${selects}`)

  await browser.close()

  console.log('\n============================================================')
  console.log(`  结果：通过 ${pass} 项，失败 ${fail} 项`)
  console.log('============================================================')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('\n[脚本错误]', e.message)
  process.exit(2)
})
