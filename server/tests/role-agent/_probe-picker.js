/**
 * 一次性探针：展开「出库类型」picker，把展开面板的 DOM 结构打出来。
 * 起因：.uni-picker-action-confirm 这个类名在 uni-h5 源码里确实存在，
 *   但 Playwright 说 :visible 找不到 → 要亲眼看它到底挂在哪、什么状态。
 * 用法：H5_URL=http://127.0.0.1:5174 node tests/role-agent/_probe-picker.js
 */
let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const H5_URL = process.env.H5_URL || 'http://127.0.0.1:5174'

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => {
    try { localStorage.setItem('sl_dev_openid', 'dev_director'); localStorage.removeItem('sl_token') } catch (e) { /* ignore */ }
  })
  // 直接进成品仓出库页
  await page.goto(`${H5_URL}/#/pages/out/submit?wh=chengpin`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)

  // 加一个物料进清单（picker 只在清单非空时渲染）
  const mat = page.locator('.material-item').first()
  if (await mat.count()) { await mat.click(); await page.waitForTimeout(1200) }

  // 展开 picker
  await page.locator('.picker').first().click()
  await page.waitForTimeout(1000)

  const info = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'
    }
    const rectOf = (el) => {
      const r = el.getBoundingClientRect()
      return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
    }
    const out = { layers: [], confirms: [], items: [] }
    for (const sel of ['.uni-picker-container', '.uni-picker-mask', '.uni-picker-custom',
      '.uni-picker-header', '.uni-picker-content', '.uni-picker-select']) {
      document.querySelectorAll(sel).forEach((el, i) => {
        out.layers.push(`${sel}#${i} visible=${vis(el)} rect=${rectOf(el)}`)
      })
    }
    document.querySelectorAll('.uni-picker-action-confirm').forEach((el, i) => {
      out.confirms.push(`#${i} visible=${vis(el)} rect=${rectOf(el)} text="${el.innerText}"`)
    })
    document.querySelectorAll('.uni-picker-item').forEach((el, i) => {
      const inContent = !!el.closest('.uni-picker-content')
      const inSelect = !!el.closest('.uni-picker-select')
      out.items.push(`#${i} visible=${vis(el)} in=${inContent ? 'content' : inSelect ? 'select' : '?'} text="${el.innerText}"`)
    })
    return out
  })
  console.log('== 层级 =='); info.layers.forEach((s) => console.log('  ' + s))
  console.log('== confirm 按钮 =='); info.confirms.forEach((s) => console.log('  ' + s))
  console.log('== 选项 =='); info.items.forEach((s) => console.log('  ' + s))

  // 试：点可见的「领用」，不点确认，直接看 picker-value 有没有变
  await page.locator('.uni-picker-item:visible').filter({ hasText: '领用' }).first().click()
  await page.waitForTimeout(600)
  const pv1 = (await page.locator('.picker-value').first().innerText()).trim()
  console.log(`== 点完「领用」（未点确认）后 picker-value = "${pv1}"`)

  // 再把 confirm 的真实状态补打一次（可能刚才动画没播完）
  const confirm2 = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.uni-picker-action-confirm'))
    return els.map((el) => {
      const r = el.getBoundingClientRect()
      return `rect=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)} display=${getComputedStyle(el).display} text="${el.innerText}"`
    })
  })
  console.log('== confirm 二次确认 =='); confirm2.forEach((s) => console.log('  ' + s))

  await browser.close()
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
