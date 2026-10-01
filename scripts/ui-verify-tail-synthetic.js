/**
 * 一次性验证：列表没有真实数据时，注入等身高度的卡片模拟「超出一屏」的列表，
 * 滚到底看最后一张卡片能不能越过底部固定栏（验证 padding-bottom 是否够）。
 *
 * 为什么要这么做：盘点提交页 / 盘点列表页本地没有数据可渲染，
 * 而它们的缺陷恰恰是「列表底伸到屏幕外 / 被底部栏盖住」，
 * 只量盒子不够，必须让内容真的滚起来。
 */
const { chromium } = require('playwright')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const BASE = 'http://localhost:5199'
const API = 'http://119.91.206.235:3000'

const CASES = [
  { route: 'pages/check/list', list: '.check-list', bar: '.create-bar' },
  { route: 'pages/check/submit', list: '.material-list', bar: '.submit-bar' }
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

  for (const c of CASES) {
    await page.goto(`${BASE}/#/${c.route}`, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(2500)

    const out = await page.evaluate(
      ({ listSel, barSel }) => {
        const outer = document.querySelector(listSel)
        const bar = document.querySelector(barSel)
        if (!outer) return { error: '找不到列表 ' + listSel }
        if (!bar) return { error: '找不到底部栏 ' + barSel }

        // 找真正滚动的元素：按 overflow 判定。
        // 不能用「scrollHeight > clientHeight」当判据 —— 列表没数据时先命中的是
        // 下拉刷新元素(uni-scroll-view-refresher)，会让测试得出假结论。
        const cands = [outer, ...outer.querySelectorAll('*')].filter((el) => {
          const s = getComputedStyle(el)
          return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.clientHeight > 100
        })
        const scroller = cands.length ? cands[0] : outer
        const content =
          scroller.querySelector('.uni-scroll-view-content') || scroller.firstElementChild || scroller

        // 注入 12 张 200px 的卡片（远超过一屏）
        const before = content.children.length
        for (let i = 0; i < 12; i++) {
          const d = document.createElement('div')
          d.className = 'synth-card'
          d.style.cssText =
            'height:200px;background:#fff;border-radius:8px;margin-bottom:8px;display:flex;align-items:center;padding-left:12px;box-sizing:border-box'
          d.textContent = '注入卡片 ' + (i + 1)
          content.appendChild(d)
        }
        const cards = [...content.querySelectorAll('.synth-card')]

        // 滚到底（外层与内层都赋值，兼容两种结构）
        const el = scroller
        el.scrollTop = el.scrollHeight
        outer.scrollTop = outer.scrollHeight

        const last = cards[cards.length - 1]
        const lr = last.getBoundingClientRect()
        const br = bar.getBoundingClientRect()
        const listR = outer.getBoundingClientRect()
        const cs = getComputedStyle(outer)

        return {
          injected: cards.length,
          childrenBefore: before,
          scrollerCls: scroller.className.toString().slice(0, 50),
          scrollerMaxScroll: scroller.scrollHeight - scroller.clientHeight,
          scrollerScrollTop: Math.round(scroller.scrollTop),
          listPaddingBottom: cs.paddingBottom,
          listBoxBottom: Math.round(listR.bottom),
          barHeight: Math.round(br.height),
          barTop: Math.round(br.top),
          lastCardBottom: Math.round(lr.bottom),
          lastCardVisible: lr.bottom <= br.top + 1,
          hiddenPx: Math.max(0, Math.round(lr.bottom - br.top)),
          viewportH: window.innerHeight,
          pageScroll: document.body.scrollHeight - window.innerHeight
        }
      },
      { listSel: c.list, barSel: c.bar }
    )

    console.log('\n===== ' + c.route + ' =====')
    console.log(JSON.stringify(out, null, 2))
    console.log(
      out.lastCardVisible
        ? `✅ 最后一张卡片（底 ${out.lastCardBottom}）在底部栏上沿（${out.barTop}）之上，未被遮挡`
        : `❌ 最后一张卡片被底部栏遮住 ${out.hiddenPx}px`
    )
    await page.screenshot({ path: `docs/screenshots/${c.route.replace(/\//g, '-')}-synth-tail.png` })
  }

  await browser.close()
})().catch((e) => {
  console.error('失败：', e)
  process.exit(1)
})
