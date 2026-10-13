/**
 * 诊断：小程序 H5 入库提交页的真实 DOM 结构
 * 用法：node scripts/_probe-in-submit-dom.js
 */
const { chromium } = require('playwright')
const http = require('http')

const CHROME = 'C:/Users/kass/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const H5 = 'http://localhost:5199'
const LOCAL_API = 'http://127.0.0.1:3000'
const PROD_API = 'http://119.91.206.235:3000'

function apiCall(module, action, data, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ action, data })
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(`${LOCAL_API}/api/${module}`, { method: 'POST', headers, timeout: 20000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch (e) { resolve({ code: -999 }) } })
    })
    req.on('error', () => resolve({ code: -1 }))
    req.write(payload); req.end()
  })
}

;(async () => {
  const login = await apiCall('auth', 'login', { dev_openid: 'dev_purchase' })
  const browser = await chromium.launch({ executablePath: CHROME })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await page.route(`${PROD_API}/**`, async (r) => {
    await r.continue({ url: r.request().url().replace(PROD_API, LOCAL_API) })
  })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))

  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.evaluate((p) => {
    uni.setStorageSync('sl_token', p.token)
    uni.setStorageSync('sl_user', p.user)
  }, { token: login.data.token, user: login.data.user })

  await page.goto(`${H5}/#/pages/in/submit`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(5000)

  console.log('URL:', page.url())
  console.log('pageerror:', JSON.stringify(errs))
  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map((el) => ({
      ph: el.getAttribute('placeholder'),
      cls: el.className,
      type: el.type,
      visible: el.offsetWidth > 0 && el.offsetHeight > 0
    }))
    const uniInputs = Array.from(document.querySelectorAll('uni-input')).map((el) => el.outerHTML.slice(0, 200))
    return {
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      inputCount: inputs.length,
      inputs: inputs.slice(0, 12),
      uniInputCount: uniInputs.length,
      uniInputs: uniInputs.slice(0, 4),
      matItems: document.querySelectorAll('.material-item').length,
      cls: Array.from(document.querySelectorAll('[class]')).slice(0, 30).map((e) => e.className).slice(0, 30)
    }
  })
  console.log(JSON.stringify(info, null, 2))
  await page.screenshot({ path: 'G:/sl/shenglong-erp/.tmp-local-audit/_probe-in-submit.png', fullPage: false })
  await browser.close()
})()
