/**
 * 诊断：首页渲染是否正常
 * 目的 —— 区分「render 没执行(数据全空)」与「render 执行了但分支为空」
 * 用法：node scripts/_probe-home-render.js
 */
const { chromium } = require('playwright')

const H5 = process.env.H5 || 'http://127.0.0.1:5199'
const EXE = process.env.CHROME_EXE || null

;(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {})
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()

  const logs = []
  const errors = []
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(5000)

  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const txt = (s) => (q(s)?.textContent || '').trim()
    return {
      url: location.href,
      // 标题与副标题
      title: txt('uni-text.title'),
      subtitle: txt('uni-text.subtitle'),
      // 各分支是否存在
      hasLoading: !!q('uni-view.loading'),
      hasIntro: !!q('uni-view.intro'),
      hasPending: !!q('uni-view.pending-prompt'),
      hasLoggedIn: !!q('uni-view.logged-in'),
      hasUserInfo: !!q('uni-view.user-info'),
      // 整页可见文本
      bodyText: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 400),
      // 是否有 uni-view 之外的原始节点
      viewCount: document.querySelectorAll('uni-view').length
    }
  })

  console.log('=== 首页渲染诊断 ===')
  console.log(JSON.stringify(info, null, 2))
  console.log('\n=== 控制台 error/warning（最多 20 条）===')
  console.log(logs.slice(0, 20).join('\n') || '（无）')
  console.log('\n=== 未捕获异常 ===')
  console.log(errors.slice(0, 10).join('\n') || '（无）')

  // 再等一轮，看是否延迟渲染
  await page.waitForTimeout(4000)
  const again = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 300))
  console.log('\n=== 再等 4 秒后的文本 ===')
  console.log(again)

  await page.screenshot({ path: 'G:/sl/shenglong-erp/.tmp-local-audit/probe-home.png', fullPage: false })
  await browser.close()
})().catch((e) => {
  console.error('探针异常:', e.message)
  process.exit(1)
})
