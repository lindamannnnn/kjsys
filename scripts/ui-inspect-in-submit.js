/**
 * 入库提交页 UI 实测脚本（H5 版本，真机视口 390x844）
 *
 * 目的：定位「底部表单面板出现后不收回 + 输入框显示不全」的真实原因，用测量数据说话。
 * 做法：借应用自己的 uni.setStorageSync 注入登录态，避免手写 storage 格式猜错。
 *
 * 运行：
 *   NODE_PATH=<ws-node-modules> node scripts/ui-inspect-in-submit.js
 * 可调：
 *   H5_BASE   默认 http://localhost:5199
 *   API_BASE  默认 http://119.91.206.235:3000
 */
const { chromium } = require('playwright')

const BASE = process.env.H5_BASE || 'http://localhost:5199'
const API = process.env.API_BASE || 'http://119.91.206.235:3000'
const PAGE_URL = `${BASE}/#/pages/in/submit`

// 本机 playwright-core 版本比已下载的浏览器新，直接指定已有的 chromium 可执行文件
const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2
  })

  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  // ---- 1. 用应用自身的 storage API 注入登录态 ----
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(1500)

  const loginInfo = await page.evaluate(async (api) => {
    try {
      const r = await fetch(`${api}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'login',
          data: { dev_openid: 'dev_worker_01' },
          client_request_id: 'ui-inspect-' + Date.now()
        })
      })
      const j = await r.json()
      if (j.code !== 0) return { ok: false, msg: j.message }
      // 用 uni 自己的实现写，格式一定对
      uni.setStorageSync('sl_token', j.data.token)
      uni.setStorageSync('sl_user', j.data.user)
      return { ok: true, user: j.data.user && j.data.user.name, roles: j.data.roles }
    } catch (e) {
      return { ok: false, msg: String(e) }
    }
  }, API)
  console.log('>> 登录态注入：', JSON.stringify(loginInfo))

  // ---- 2. 打开入库页 ----
  await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(3000)

  const matCount = await page.locator('.material-item').count()
  console.log('>> 物料卡片数量：', matCount)

  // ---- 3. 点第一个物料，唤出底部面板 ----
  if (matCount > 0) {
    await page.locator('.material-item').first().click()
    await page.waitForTimeout(1200)
  }

  const measure = async (label) => {
    const r = await page.evaluate(() => {
      const q = (s) => document.querySelector(s)
      const box = (el) => {
        if (!el) return null
        const rect = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          h: Math.round(rect.height),
          w: Math.round(rect.width),
          pad: `${cs.paddingTop}/${cs.paddingBottom}`,
          font: cs.fontSize,
          lh: cs.lineHeight,
          overflow: cs.overflow,
          pos: cs.position,
          zIndex: cs.zIndex
        }
      }
      const panel = q('.submit-panel')
      // 面板内部结构（uni-app H5 把 input 包了一层自定义元素）
      const firstInput = q('.submit-panel .input')
      const innerInput = firstInput ? firstInput.querySelector('input') : null
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        docScrollH: document.documentElement.scrollHeight,
        panel: box(panel),
        panelScrollH: panel ? panel.scrollHeight : null,
        panelClientH: panel ? panel.clientHeight : null,
        panelOverflowTop: panel ? Math.round(panel.getBoundingClientRect().top) < 0 : null,
        outerInputTag: firstInput ? firstInput.tagName : null,
        outerInput: box(firstInput),
        innerInputTag: innerInput ? innerInput.tagName : null,
        innerInput: box(innerInput),
        innerInputIsClipped: innerInput
          ? innerInput.scrollHeight > innerInput.getBoundingClientRect().height + 1
          : null,
        // 面板里有没有「关闭」入口
        hasCloseBtn: !!q('.submit-panel .panel-close, .submit-panel .close-btn'),
        // 有没有遮罩
        hasMask: !!q('.panel-mask, .submit-mask')
      }
    })
    console.log(`\n===== ${label} =====`)
    console.log(JSON.stringify(r, null, 2))
    return r
  }

  await measure('面板出现后（点击物料）')

  const panelOpen = () => page.locator('.submit-panel').count()
  const openPanel = async () => {
    if ((await panelOpen()) === 0) {
      await page.locator('.material-item').first().click()
      await page.waitForTimeout(700)
    }
  }
  await page.screenshot({ path: 'docs/screenshots/in-submit-panel-open.png' })

  // ---- 4. 三种收起路径，逐条验证 ----
  const results = []

  // 4.1 点列表空白处
  await openPanel()
  const listBox = await page.locator('.material-list').boundingBox()
  const before1 = await panelOpen()
  // 点列表顶部那条可见空隙（面板上沿之上）
  const panelBox = await page.locator('.submit-panel').boundingBox()
  const clickY = Math.max(listBox.y + 8, Math.min(panelBox.y - 8, listBox.y + listBox.height - 8))
  await page.mouse.click(listBox.x + listBox.width / 2, clickY)
  await page.waitForTimeout(700)
  results.push(`点列表空白处（y=${Math.round(clickY)}）：${before1} → ${await panelOpen()}`)

  // 4.2 点 ✕ 关闭按钮
  await openPanel()
  const before2 = await panelOpen()
  await page.locator('.submit-panel .panel-close').click()
  await page.waitForTimeout(700)
  results.push(`点 ✕ 收起按钮：${before2} → ${await panelOpen()}`)

  // 4.3 再点同一物料
  await openPanel()
  const before3 = await panelOpen()
  await page.locator('.material-item').first().click()
  await page.waitForTimeout(700)
  results.push(`再点同一物料：${before3} → ${await panelOpen()}`)

  // uni-app H5 的 scroll-view 外层是自定义元素、内层 div 才真正滚动，
  // 这里直接找「第一个真的能滚」的后代，别猜层级。
  const scrollList = (top) =>
    page.evaluate((v) => {
      const outer = document.querySelector('.material-list')
      const cands = [outer, ...outer.querySelectorAll('*')]
      const target = cands.find((el) => el.scrollHeight > el.clientHeight + 10) || outer
      target.scrollTop = v === 'bottom' ? target.scrollHeight : v
      return { top: Math.round(target.scrollTop), cls: String(target.className || '').slice(0, 30) }
    }, top)

  // 4.4 点另一个物料 = 换料（滚动列表让第 2 个物料露进空隙）
  await openPanel()
  const nameBefore = await page.locator('.selected-name').innerText()
  await scrollList(150)
  await page.waitForTimeout(600)

  const readStrip = () =>
    page.evaluate(() => {
      const list = document.querySelector('.material-list')
      const panel = document.querySelector('.submit-panel')
      const lr = list.getBoundingClientRect()
      const pr = panel ? panel.getBoundingClientRect() : null
      const stripTop = lr.top + 2
      const stripBottom = (pr ? pr.top : lr.bottom) - 2
      const items = [...document.querySelectorAll('.material-item')].map((el) => {
        const r = el.getBoundingClientRect()
        // 卡片露在面板上方的可见高度（卡片本身可能被滚出列表上沿）
        const visTop = Math.max(r.top, stripTop)
        const visBottom = Math.min(r.bottom, stripBottom)
        const band = visBottom - visTop
        return {
          name: el.innerText.split('\n')[0],
          band: Math.round(band),
          cx: r.left + r.width / 2,
          cy: (visTop + visBottom) / 2
        }
      })
      return { stripTop: Math.round(stripTop), stripBottom: Math.round(stripBottom), items }
    })

  let strip = await readStrip()
  let visible = strip.items.filter((i) => i.band >= 40)
  console.log(
    `\n>> 面板打开时：列表可见空隙 ${strip.stripTop} → ${strip.stripBottom} px（${
      strip.stripBottom - strip.stripTop
    }px），可点物料 ${visible.length} 个（可见高度 ${visible.map((i) => i.band).join('/')}）`
  )

  // 挑一个与当前选中不同、且露出高度足够的物料
  let target = visible.find((i) => i.name !== nameBefore)
  if (!target) {
    for (const off of [130, 260, 400, 540]) {
      await scrollList(off)
      await page.waitForTimeout(500)
      strip = await readStrip()
      visible = strip.items.filter((i) => i.band >= 40)
      target = visible.find((i) => i.name !== nameBefore)
      if (target) break
    }
  }

  if (target) {
    await page.mouse.click(target.cx, target.cy)
    await page.waitForTimeout(900)
    const nameAfter = await page.locator('.selected-name').innerText().catch(() => '(面板已关)')
    results.push(
      `换料（点露出 ${target.band}px 的 "${target.name}"）：面板=${await panelOpen()}，标题 "${nameBefore}" → "${nameAfter}"`
    )
  } else {
    results.push('换料：跳过（没有露出足够高度、且不是当前选中的物料）')
  }

  // 4.5 面板打开时把列表滚到底，最后一个物料应该能露到面板上方
  await openPanel()
  const scrolled = await scrollList('bottom')
  await page.waitForTimeout(700)
  const tail = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.material-item')]
    const last = items[items.length - 1]
    const panel = document.querySelector('.submit-panel')
    const lr = last.getBoundingClientRect()
    const pr = panel ? panel.getBoundingClientRect() : null
    return {
      lastBottom: Math.round(lr.bottom),
      panelTop: pr ? Math.round(pr.top) : null,
      reachable: pr ? lr.bottom <= pr.top + 4 : null
    }
  })
  results.push(
    `滚到底(${scrolled.cls} scrollTop=${scrolled.top})：最后物料底 ${tail.lastBottom} / 面板上沿 ${tail.panelTop}，不被遮挡=${tail.reachable}`
  )

  console.log('\n===== 收起行为验证 =====')
  results.forEach((r) => console.log('  · ' + r))

  // 面板打开状态留一张图
  await openPanel()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'docs/screenshots/in-submit-after-fix.png' })
  console.log('>> 截图：docs/screenshots/in-submit-after-fix.png')

  if (logs.length) console.log('\n--- 浏览器日志 ---\n' + logs.slice(-15).join('\n'))

  await browser.close()
})().catch((e) => {
  console.error('脚本失败：', e)
  process.exit(1)
})
