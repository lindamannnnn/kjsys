/** 快速探针：确认 localhost:5173 与 127.0.0.1:5173 分别开到哪个站点 */
const { chromium } = require('playwright')
const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://localhost:5199/']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(2500)
      const info = await page.evaluate(() => ({
        title: document.title,
        head: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
        hasEl: !!document.querySelector('.el-menu, .el-container'),
        len: (document.body.innerText || '').length
      }))
      console.log(`${url}\n   title="${info.title}"\n   ElementPlus布局=${info.hasEl} 文字长度=${info.len}\n   内容：${info.head}\n`)
    } catch (e) {
      console.log(`${url}\n   打开失败：${e.message.slice(0, 100)}\n`)
    }
    await page.close()
  }
  await browser.close()
  process.exit(0)
})()
