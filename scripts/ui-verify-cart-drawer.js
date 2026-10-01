/**
 * 清单抽屉（出库 / 采购）行为回归。
 *
 * 覆盖本轮改动：空清单不再展开抽屉（只留一条栏头提示）、有料时行为与以前完全一致。
 * 用真实浏览器驱动，不靠看代码推断。
 *
 * 注意：出库页按设计不让领零库存的货，本地两个仓库存可能全为 0 → 加料步骤会自动跳过，
 * 只验证空态（空态才是本轮改动的部分）。
 *
 * 用法：node scripts/ui-verify-cart-drawer.js
 */
const { chromium } = require('playwright')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const BASE = process.env.H5_BASE || 'http://localhost:5199'
const API = process.env.API_BASE || 'http://119.91.206.235:3000'

const PAGES = [
  { route: 'pages/purchase/submit', label: '采购入库' },
  { route: 'pages/out/submit', label: '领料出库' }
]

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.evaluate(async (api) => {
    const r = await fetch(api + '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', data: { dev_openid: 'dev_worker_01' } })
    })
    const j = await r.json()
    uni.setStorageSync('sl_token', j.data.token)
    uni.setStorageSync('sl_user', j.data.user)
  }, API)

  const readPanel = () =>
    page.evaluate(() => {
      const header = document.querySelector('.cart-header')
      const panel = document.querySelector('.cart-panel')
      const items = document.querySelector('.cart-items')
      const footer = document.querySelector('.cart-footer')
      const toggle = document.querySelector('.cart-toggle')
      return {
        title: header ? header.innerText.split('\n')[0].trim() : null,
        hasToggle: !!toggle,
        hasItems: !!items,
        hasFooter: !!footer,
        panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
        headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
        itemCount: document.querySelectorAll('.cart-item').length
      }
    })

  const results = []
  const ok = (cond, msg) => results.push(`${cond ? '✅' : '❌'} ${msg}`)

  for (const p of PAGES) {
    await page.goto(`${BASE}/#/${p.route}`, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(3000)

    console.log(`\n===== ${p.label} · 清单抽屉 =====`)
    let s = await readPanel()
    console.log('初始（空清单）：', JSON.stringify(s))
    ok(s.title.includes('点下方物料加入'), `[${p.label}] 空态栏头给出加料提示：「${s.title}」`)
    ok(!s.hasToggle, `[${p.label}] 空态不显示「展开」开关（点了也没内容）`)
    ok(!s.hasItems, `[${p.label}] 空态不渲染清单区（省下 60px，不压住列表最后一张卡片）`)
    ok(s.panelH === s.headerH, `[${p.label}] 空态面板高度=栏头高度（${s.panelH}px），无多余占位`)

    const mat = page.locator('.material-item').first()
    if (!(await mat.count())) {
      results.push(`（${p.label} 没有物料可选，跳过加料步骤）`)
      continue
    }

    await mat.click()
    await page.waitForTimeout(1200)
    s = await readPanel()
    if (s.itemCount === 0) {
      results.push(`（${p.label} 物料加不进清单——零库存被业务拦截，跳过加料步骤）`)
      continue
    }
    console.log('加料后：', JSON.stringify(s))
    ok(/\(\d+ 项\)/.test(s.title), `[${p.label}] 栏头变成计数「${s.title}」`)
    ok(s.hasToggle, `[${p.label}] 出现「收起/展开」开关`)
    ok(s.hasItems && s.itemCount >= 1, `[${p.label}] 清单区渲染出 ${s.itemCount} 条`)
    ok(s.hasFooter, `[${p.label}] 提交区出现`)

    await page.locator('.cart-header').click()
    await page.waitForTimeout(900)
    const collapsed = await readPanel()
    console.log('点栏头收起：', JSON.stringify(collapsed))
    ok(!collapsed.hasItems, `[${p.label}] 收起后清单区消失`)
    ok(collapsed.panelH === collapsed.headerH, `[${p.label}] 收起后只剩栏头（${collapsed.panelH}px）`)

    await page.locator('.cart-header').click()
    await page.waitForTimeout(900)
    const expanded = await readPanel()
    console.log('再点展开：', JSON.stringify(expanded))
    ok(expanded.hasItems, `[${p.label}] 再点能展开回来（开关双向可用）`)

    const removeBtn = page.locator('.remove-btn').first()
    if (await removeBtn.count()) {
      await removeBtn.click()
      await page.waitForTimeout(1200)
      const empty = await readPanel()
      console.log('删空后：', JSON.stringify(empty))
      ok(empty.title.includes('点下方物料加入'), `[${p.label}] 删空回到空态提示：「${empty.title}」`)
      ok(!empty.hasItems, `[${p.label}] 删空后清单区消失（不会留一块空面板）`)
    }
  }

  await page.screenshot({ path: 'docs/screenshots/cart-drawer.png' })

  console.log('\n===== 结论 =====')
  results.forEach((r) => console.log('  ' + r))
  const failed = results.filter((r) => r.startsWith('❌')).length
  console.log(`\n通过 ${results.length - failed} 条，失败 ${failed} 条`)

  await browser.close()
})().catch((e) => {
  console.error('失败：', e)
  process.exit(1)
})
