/**
 * 量「整屏高度」类页面：列表有没有填到屏幕底部、最后一张卡片滚到底会不会被底部栏遮住。
 *
 * 背景：项目里列表高度写成 `calc(100vh - Nrpx)` 魔法数字。
 *   - N 比「列表上方实际占用」大 → 列表底离屏幕底差一截，露出一条纯背景灰带（用户报的就是这个）
 *   - N 比实际小 → 列表底伸到屏幕外，最后一张卡片永远滚不进可视区
 * 正确写法是「容器整屏 + 列表 flex:1」，不需要任何魔法数字。
 *
 * 用法：
 *   ROUTES=pages/in/submit,pages/out/submit node scripts/ui-probe-list-height.js
 * 依赖：H5 dev server 在 5199（可用 H5_BASE 覆盖），后端 3000（API_BASE 覆盖）
 */
const { chromium } = require('playwright')
const path = require('path')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const BASE = process.env.H5_BASE || 'http://localhost:5199'
const API = process.env.API_BASE || 'http://119.91.206.235:3000'
const ROUTES = (process.env.ROUTES || 'pages/in/submit').split(',')

const LIST_SEL = ['.material-list', '.order-list', '.check-list']
const CARD_SEL = ['.material-item', '.order-item', '.check-item']
const BAR_SEL = ['.cart-header', '.create-bar', '.submit-bar', '.cart-footer']

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('pageerror', (e) => console.log('   [页面错误]', e.message))

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(2000)

  const loginOk = await page.evaluate(async (api) => {
    try {
      const r = await fetch(api + '/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', data: { dev_openid: 'dev_worker_01' } })
      })
      const j = await r.json()
      if (!j || !j.data || !j.data.token) return '登录接口返回异常: ' + JSON.stringify(j).slice(0, 120)
      uni.setStorageSync('sl_token', j.data.token)
      uni.setStorageSync('sl_user', j.data.user)
      return 'ok'
    } catch (e) {
      return '登录失败: ' + e.message
    }
  }, API)
  console.log('登录态注入：', loginOk)
  if (loginOk !== 'ok') {
    await browser.close()
    process.exit(1)
  }

  const rows = []

  for (const route of ROUTES) {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(3000)

    const probe = await page.evaluate(
      ({ LIST_SEL, CARD_SEL, BAR_SEL }) => {
        const vw = window.innerWidth
        const rpx = (px) => Math.round((px / vw) * 750)
        const rectOf = (sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            sel,
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            h: Math.round(r.height),
            topRpx: rpx(r.top),
            hRpx: rpx(r.height)
          }
        }
        const listSel = LIST_SEL.find((s) => document.querySelector(s)) || null
        const cardSel = CARD_SEL.find((s) => document.querySelector(s)) || null
        const barSel = BAR_SEL.find((s) => document.querySelector(s)) || null
        const list = listSel ? rectOf(listSel) : null
        const bar = barSel ? rectOf(barSel) : null
        const cardCount = cardSel ? document.querySelectorAll(cardSel).length : 0

        // 找真正的滚动容器：不能只看「谁 scrollHeight > clientHeight」——
        // 没有数据时优先命中的是下拉刷新元素(uni-scroll-view-refresher)，会得出假结论。
        // 按 overflow 判定才可靠：uni H5 的 .uni-scroll-view 才是 overflow:auto 的那个。
        let scroller = null
        if (listSel) {
          const outer = document.querySelector(listSel)
          scroller = outer
          const cands = [outer, ...outer.querySelectorAll('*')].filter((el) => {
            const s = getComputedStyle(el)
            return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.clientHeight > 100
          })
          if (cands.length) scroller = cands[0]
        }
        const scrollInfo = scroller
          ? {
              cls: scroller.className.toString().slice(0, 40),
              scrollH: scroller.scrollHeight,
              clientH: scroller.clientHeight,
              maxScroll: scroller.scrollHeight - scroller.clientHeight
            }
          : null

        const cs = document.querySelector('.container')
        const ccs = cs ? getComputedStyle(cs) : null

        // rpx 基准：H5 端 rpx 是构建期转换的（浏览器不认这个单位），
        // 但转换是线性的 —— 用一个「源文件里写了已知 rpx padding」的元素反推 1rpx = ?px，
        // 之后就能把量到的 px 换算回 rpx（rpx 才是小程序端同源的单位）。
        const rpxSources = [
          ['.wh-bar', 16, 'paddingTop'],
          ['.sub-bar', 10, 'paddingTop'],
          ['.material-item', 30, 'paddingTop'],
          ['.cart-header', 24, 'paddingTop'],
          ['.container', 20, 'paddingLeft'],
          ['.create-bar', 20, 'paddingTop']
        ]
        let rpxRatio = null
        let rpxSource = null
        for (const [sel, rpx, prop] of rpxSources) {
          const el = document.querySelector(sel)
          if (!el) continue
          const v = parseFloat(getComputedStyle(el)[prop])
          if (v > 0) {
            rpxRatio = +(v / rpx).toFixed(4)
            rpxSource = `${sel} ${prop}=${rpx}rpx→${v}px`
            break
          }
        }
        const toRpx = (px) => (rpxRatio ? Math.round(px / rpxRatio) : null)

        // 底部固定栏（购物车 header / 新建条 / 提交按钮）
        const barEl = document.querySelector('.cart-header, .create-bar, .submit-bar, .cart-footer, .btn-submit')
        let bottomBar = null
        if (barEl) {
          const r = barEl.getBoundingClientRect()
          bottomBar = {
            cls: barEl.className.toString().slice(0, 40),
            h: Math.round(r.height),
            hRpx: toRpx(r.height),
            top: Math.round(r.top),
            text: (barEl.innerText || '').split('\n')[0].slice(0, 20)
          }
        }

        return {
          innerH: window.innerHeight,
          innerW: vw,
          bodyScroll: document.body.scrollHeight - window.innerHeight,
          windowTop: getComputedStyle(document.documentElement).getPropertyValue('--window-top').trim(),
          rpxRatio,
          rpxSource,
          container: ccs
            ? { h: ccs.height, display: ccs.display, pb: ccs.paddingBottom, minH: ccs.minHeight }
            : null,
          listSel,
          list,
          bottomBar,
          cardCount,
          scrollInfo
        }
      },
      { LIST_SEL, CARD_SEL, BAR_SEL }
    )

    // 滚到底，量最后一张卡片有没有被屏幕底/底部栏遮住
    let tail = null
    if (probe.scrollInfo) {
      tail = await page.evaluate(
        ({ LIST_SEL, CARD_SEL, BAR_SEL }) => {
          const listSel = LIST_SEL.find((s) => document.querySelector(s))
          const cardSel = CARD_SEL.find((s) => document.querySelector(s))
          const barSel = BAR_SEL.find((s) => document.querySelector(s))
          const outer = document.querySelector(listSel)
          // 同主探针：按 overflow 找真滚动容器，别被下拉刷新元素骗了
          const cands = [outer, ...outer.querySelectorAll('*')].filter((el) => {
            const s = getComputedStyle(el)
            return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.clientHeight > 100
          })
          const scroller = cands.length ? cands[0] : outer
          scroller.scrollTop = scroller.scrollHeight

          const cards = [...document.querySelectorAll(cardSel)]
          const last = cards[cards.length - 1]
          if (!last) return null
          const lr = last.getBoundingClientRect()
          const bar = barSel ? document.querySelector(barSel).getBoundingClientRect() : null
          const listR = outer.getBoundingClientRect()
          // 可见下边界 = 屏幕底，以及（如果有底部栏）底部栏上沿
          const limit = Math.min(window.innerHeight, bar ? bar.top : Infinity)
          return {
            lastCardName: (last.innerText || '').split('\n')[0],
            lastCardBottom: Math.round(lr.bottom),
            listTop: Math.round(listR.top),
            barTop: bar ? Math.round(bar.top) : null,
            screenBottom: window.innerHeight,
            visibleLimit: Math.round(limit),
            fullyVisible: lr.bottom <= limit + 2,
            hiddenPx: Math.max(0, Math.round(lr.bottom - limit)),
            // 卡片盒子整个在可视条带里（上沿也要能看到）
            cardAboveListTop: lr.top < listR.top
          }
        },
        { LIST_SEL, CARD_SEL, BAR_SEL }
      )
    }

    const dead = probe.list ? Math.round(probe.innerH - Math.min(probe.list.bottom, probe.innerH)) : null

    const verdict =
      dead === null
        ? '（本页没找到列表容器）'
        : dead === 0 && (!tail || tail.fullyVisible)
          ? '✅ 正常'
          : dead > 0
            ? `❌ 底部灰带 ${dead}px`
            : '❌ 列表伸出屏幕外'

    console.log(`\n===== ${route} ===== ${verdict}`)
    console.log(JSON.stringify({ ...probe, tail }, null, 2))

    const shot = path.join('docs/screenshots', route.replace(/^pages\//, '').replace(/\//g, '-') + '-list.png')
    await page.screenshot({ path: shot })
    console.log('>> 截图：' + shot)

    rows.push({ route, verdict, dead, tailBottom: tail ? tail.lastCardBottom : null, limit: tail ? tail.visibleLimit : null })
  }

  console.log('\n========== 汇总 ==========')
  rows.forEach((r) =>
    console.log(
      `${r.verdict.padEnd(24)} ${r.route}` +
        (r.tailBottom !== null ? `   滚到底最后卡片底 ${r.tailBottom} / 可见下限 ${r.limit}` : '')
    )
  )

  await browser.close()
})().catch((e) => {
  console.error('脚本失败：', e)
  process.exit(1)
})
