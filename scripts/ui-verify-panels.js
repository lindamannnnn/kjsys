/**
 * 出库 / 采购 / 我的 三页输入框与浮层回归（H5 真机视口 390x844）
 *
 * 目的：验证「把 uni-input 显式给高度」后，输入框不再塌陷，
 *       且底部抽屉变高后没有把提交按钮挤出屏幕。
 *
 * 运行：NODE_PATH=<ws-node-modules> node scripts/ui-verify-panels.js
 */
const { chromium } = require('playwright')

const BASE = process.env.H5_BASE || 'http://localhost:5199'
const API = process.env.API_BASE || 'http://119.91.206.235:3000'
const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'

const probeInputs = () =>
  [...document.querySelectorAll('uni-input')].map((el) => {
    const r = el.getBoundingClientRect()
    const inner = el.querySelector('input')
    const ph = el.querySelector('.uni-input-placeholder')
    const ir = inner ? inner.getBoundingClientRect() : null
    const pr = ph ? ph.getBoundingClientRect() : null
    const phText = (ph && ph.innerText) || ''
    return {
      h: Math.round(r.height),
      innerH: ir ? Math.round(ir.height) : null,
      placeholder: phText || (inner && inner.placeholder) || '',
      // 占位元素在没文字时是空的，位置无意义，只在有文字时才判它有没有超出外框
      clipped:
        (!!ir && ir.height <= 2) ||
        (!!pr && phText !== '' && (pr.top < r.top - 1 || pr.bottom > r.bottom + 1))
    }
  })

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.evaluate(async (api) => {
    const r = await fetch(`${api}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', data: { dev_openid: 'dev_worker_01' } })
    })
    const j = await r.json()
    if (j.code === 0) {
      uni.setStorageSync('sl_token', j.data.token)
      uni.setStorageSync('sl_user', j.data.user)
    }
  }, API)

  // ---- 1. 我的：直接量 ----
  await page.goto(`${BASE}/#/pages/my/profile`, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(2500)
  const profile = await page.evaluate(probeInputs)
  console.log('\n===== pages/my/profile =====')
  profile.forEach((i) =>
    console.log(
      `  外框 ${i.h}px 内层 ${i.innerH}px 被裁=${i.clipped ? '❌是' : '✅否'}  占位「${i.placeholder}」`
    )
  )

  // ---- 2. 出库 / 采购：点物料 → 购物车抽屉展开 → 量表单 ----
  for (const route of ['pages/out/submit', 'pages/purchase/submit']) {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: 'networkidle', timeout: 45000 })
    await page.waitForTimeout(3000)
    // 出库要点「有库存」的物料（库存为 0 的点了只会弹"缺货"）；
    // 采购是进货，不校验现存，直接取第一个即可。
    const needStock = route.includes('out/')
    const findInStock = () =>
      page.evaluate(() => {
        const items = [...document.querySelectorAll('.material-item')]
        const idx = items.findIndex((el) => {
          const m = (el.innerText || '').match(/库存[:：]\s*(\d+)/)
          return m && Number(m[1]) > 0
        })
        if (idx < 0) return null
        return {
          idx,
          name: (items[idx].innerText || '').split('\n')[0],
          stock: ((items[idx].innerText || '').match(/库存[:：]\s*\d+/) || [''])[0]
        }
      })

    let picked = null
    if (!needStock) {
      const n = await page.locator('.material-item').count()
      picked = n ? { idx: 0, name: '首个物料', stock: '' } : null
    } else {
      // 出库必须有库存才让加，配件仓没有就换成品仓再找
      picked = await findInStock()
      if (!picked) {
        const tabs = await page.locator('.wh-item').count()
        for (let i = 1; i < tabs && !picked; i++) {
          const wname = await page.locator('.wh-item').nth(i).innerText()
          await page.locator('.wh-item').nth(i).click()
          await page.waitForTimeout(2500)
          picked = await findInStock()
          if (picked) picked.name = `${picked.name}（${wname.trim()}）`
          else console.log(`  ·${wname.trim()} 也没有库存`)
        }
      }
    }
    if (!picked) {
      console.log(`\n===== ${route} =====\n  ⚠️ 本地数据里没有有库存的物料，跳过`)
      continue
    }
    console.log(`\n===== ${route} =====\n  选中物料：${picked.name}（${picked.stock}）`)
    // 用 locator 点击：Playwright 会在滚动容器内正确滚到元素再点，比手算坐标稳
    await page.locator('.material-item').nth(picked.idx).click({ timeout: 15000 })
    await page.waitForTimeout(1800)

    const info = await page.evaluate(probeInputs)
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.cart-panel')
      const footer = document.querySelector('.cart-footer')
      const btn = document.querySelector('.cart-footer .btn-submit')
      const g = (el) => (el ? el.getBoundingClientRect() : null)
      const pr = g(panel)
      const fr = g(footer)
      const br = g(btn)
      return {
        panelH: pr ? Math.round(pr.height) : null,
        panelTop: pr ? Math.round(pr.top) : null,
        footerBottom: fr ? Math.round(fr.bottom) : null,
        btnBottom: br ? Math.round(br.bottom) : null,
        viewportH: window.innerHeight,
        expanded: panel ? panel.className.includes('expanded') : null
      }
    })
    info.forEach((i) =>
      console.log(
        `  外框 ${i.h}px 内层 ${i.innerH}px 被裁=${i.clipped ? '❌是' : '✅否'}  占位「${i.placeholder}」`
      )
    )
    console.log(
      `  抽屉${layout.expanded ? '展开' : '收起'} 高 ${layout.panelH}px（上沿 ${layout.panelTop}）  按钮底 ${layout.btnBottom} / 视口 ${layout.viewportH}` +
        `  → 按钮在屏内=${layout.btnBottom !== null && layout.btnBottom <= layout.viewportH ? '✅' : '❌'}`
    )
  }

  await browser.close()
})().catch((e) => {
  console.error('失败：', e)
  process.exit(1)
})
