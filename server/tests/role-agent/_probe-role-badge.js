/**
 * 一次性探针：H5 下各身份冷启动后**落在哪个页面**、页面正文里有没有身份字样。
 * 用来判断 ui-check 的「首页显示该身份」到底是页面该改，还是判据过期。
 *
 * ⚠️ 2026-10-09 改版后的预期：**所有角色都落在首页工作台 `/pages/index/index`**
 *    （utils/role-home.js 已删，不再有自动跳页）。首页正文里有该角色的入口卡片
 *    与底部「角色」字样，所以「页面含身份词」依然应该成立，只是来源从
 *    「工作台页标题」变成了「首页角色卡片 + 底部身份信息」。
 *
 * 用法：H5_URL=http://127.0.0.1:5174 node tests/role-agent/_probe-role-badge.js
 */
const path = require('path')
let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const H5_URL = process.env.H5_URL || 'http://127.0.0.1:5174'
const CASES = [
  ['老板', 'dev_boss'],
  ['仓管', 'dev_sk'],
  ['厂长', 'dev_director'],
  ['采购员', 'dev_purchase'],
  ['领料员', 'dev_out']
]

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const [label, openid] of CASES) {
    const page = await browser.newPage()
    await page.addInitScript((oid) => {
      try { localStorage.setItem('sl_dev_openid', oid); localStorage.removeItem('sl_token') } catch (e) { /* ignore */ }
    }, openid)
    await page.goto(`${H5_URL}/#/`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3500)
    const info = await page.evaluate(() => {
      const url = location.hash || location.href
      const t = document.body.innerText || ''
      return { url, len: t.length, head: t.slice(0, 90).replace(/\n/g, ' '), has: t.includes('身份') }
    })
    const okLabel = info.head.includes(label) || info.head.includes(label.replace('员', ''))
    console.log(`【${label}】hash=${info.url}`)
    console.log(`   正文字数=${info.len}；含「${label}」字样=${okLabel ? '有' : '没有'}；含「身份」=${info.has ? '有' : '没有'}`)
    console.log(`   开头：${info.head}`)
    console.log('')
    await page.close()
  }
  await browser.close()
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
