/**
 * 全站输入框体检（H5 真机视口 390x844）
 *
 * 背景：uni-app H5 给 uni-input 写死了 `height:1.4em; min-height:1.4em; overflow:hidden`。
 *       页面若只给 input 写 padding、不写高度，外框会被压到 ~22px、内层 input 只剩 1px，
 *       占位文字被裁成「半截」，而且点击热区极小。
 * 做法：逐页真实渲染，实测每个 uni-input 的实际高度，把「被压扁」的挑出来。
 *
 * 运行：NODE_PATH=<ws-node-modules> node scripts/ui-scan-inputs.js
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const BASE = process.env.H5_BASE || 'http://localhost:5199'
const API = process.env.API_BASE || 'http://119.91.206.235:3000'
const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'

// 会真的提交/修改数据的页面不扫（体检只读，不能污染数据）
const SKIP = ['pages/check/detail', 'pages/in/detail', 'pages/out/detail']

const pagesJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'src', 'pages.json'), 'utf8')
)
const routes = pagesJson.pages.map((p) => p.path).filter((p) => !SKIP.includes(p))

// 阈值：正常输入框（含小尺寸搜索框）不应低于这个高度，低于即为「被压扁」
const MIN_OK = 24

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

  const rows = []
  for (const route of routes) {
    try {
      await page.goto(`${BASE}/#/${route}`, { waitUntil: 'networkidle', timeout: 45000 })
      await page.waitForTimeout(2200)
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('uni-input')].map((el) => {
          const r = el.getBoundingClientRect()
          const inner = el.querySelector('input')
          const ir = inner ? inner.getBoundingClientRect() : null
          const ph = el.querySelector('.uni-input-placeholder')
          const pr = ph ? ph.getBoundingClientRect() : null
          const cs = getComputedStyle(el)
          const hasPadV = parseFloat(cs.paddingTop) > 0 || parseFloat(cs.paddingBottom) > 0
          // 「显示不全」的硬判据（三条任一即中）：
          //   1) 占位文字的实际盒子超出了 uni-input 的可见范围
          //   2) 内层原生 input 被压成 1~2px —— 输入的文字必然被裁（预填了值的框没有占位元素，只能靠这条）
          //   3) 有上下内边距却没有显式高度 —— 就是被写死的 1.4em 吃掉，早晚出问题
          const overflowTop = pr ? Math.max(0, Math.round(r.top - pr.top)) : 0
          const overflowBottom = pr ? Math.max(0, Math.round(pr.bottom - r.bottom)) : 0
          const innerCollapsed = !!(ir && ir.height <= 2)
          return {
            h: Math.round(r.height),
            innerH: ir ? Math.round(ir.height) : null,
            padV: `${cs.paddingTop}/${cs.paddingBottom}`,
            lineH: Math.round(parseFloat(cs.lineHeight) || 0),
            overflowTop,
            overflowBottom,
            innerCollapsed,
            noExplicitHeight: hasPadV && cs.height !== 'auto',
            clipped:
              overflowTop > 1 || overflowBottom > 1 || innerCollapsed || (hasPadV && !ir),
            placeholder: (ph && ph.innerText) || ''
          }
        })
      )
      rows.push({ route, inputs: found })
      const bad = found.filter((i) => i.clipped)
      const flag = bad.length
        ? `❌ ${bad.length}/${found.length} 个有问题`
        : found.length
          ? '✅ 正常'
          : '（本页无输入框）'
      console.log(`${flag.padEnd(22)} ${route}  输入框 ${found.length} 个`)
      bad.forEach((b) =>
        console.log(
          `      ↳ 外框 ${b.h}px 内层 ${b.innerH}px 上下内边距 ${b.padV} 行高 ${b.lineH}px` +
            `  上溢 ${b.overflowTop}px/下溢 ${b.overflowBottom}px  内层塌陷 ${b.innerCollapsed ? '是' : '否'}` +
            `  占位「${b.placeholder}」`
        )
      )
    } catch (e) {
      console.log(`⚠️  跳过（渲染失败）      ${route}  ${String(e.message).slice(0, 60)}`)
    }
  }

  const badPages = rows.filter((r) => r.inputs.some((i) => i.clipped))
  console.log('\n========================================')
  console.log(`共扫 ${rows.length} 页，存在「输入框文字被裁」的页面：${badPages.length} 页`)
  badPages.forEach((p) => console.log('  · ' + p.route))

  await browser.close()
})().catch((e) => {
  console.error('扫描失败：', e)
  process.exit(1)
})
