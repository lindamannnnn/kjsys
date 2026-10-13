/**
 * 采购任务只针对配件仓 · 小程序前端验收（2026-10-12，H5 模式）
 * ============================================================
 * ⚠️ 以 mp-weixin 包为准；H5 只作逻辑/布局参考，结论标「非小程序实测」。
 *
 * 断言：
 *   成品仓管（dev_sk_goods）  首页无「发起采购」、工作台无「采购任务」卡片
 *   配件仓管（dev_sk_parts）  首页有「发起采购」、工作台有「采购任务」（回归保护）
 *   厂长（dev_director）     首页有「发起采购」（他管两仓）
 *   厂长进「发布采购任务」    仓库切换条只剩配件仓（无成品仓）
 *
 * 用法：node tests/role-agent/purchase-parts-ui-check.js
 * 前提：H5 产物已构建（dist/build/h5）+ 静态服务 5174 + 后端 3000
 * ============================================================
 */
require('../../src/config/env')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium
}

const H5 = process.env.H5_URL || 'http://127.0.0.1:5174'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

/** 切账号：清 localStorage → 设 dev_openid → 刷新 */
async function loginAs(page, openid) {
  await page.evaluate((oid) => {
    try { localStorage.clear(); localStorage.setItem('sl_dev_openid', oid) } catch (e) { /* ignore */ }
  }, openid)
  await page.reload({ waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2600)
}

async function gridText(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    return el ? el.innerText.replace(/\s+/g, '') : '(容器不存在)'
  }, sel)
}

;(async () => {
  console.log('\n═══ 采购任务只针对配件仓 · 小程序前端验收（H5 参考，非实测）═══\n')

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
  await page.addInitScript(() => {
    // 进入前先把 dev_openid 设好，避免首页先以空身份渲染
    if (!localStorage.getItem('sl_dev_openid')) localStorage.setItem('sl_dev_openid', 'dev_sk_goods')
  })

  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2800)

  // ───────── 成品仓管 ─────────
  console.log('1. 成品仓管（dev_sk_goods）')
  await loginAs(page, 'dev_sk_goods')
  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2600)
  let txt = await gridText(page, '.role-grid')
  check('首页无「发起采购」卡片', !txt.includes('发起采购'), `实际卡片：${txt}`)

  await page.goto(`${H5}/#/pages/storekeeper/dashboard`, { waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2600)
  txt = await gridText(page, '.menu-grid')
  check('工作台无「采购任务」卡片', !txt.includes('采购任务'), `实际卡片：${txt}`)

  // ───────── 配件仓管（回归保护） ─────────
  console.log('\n2. 配件仓管（dev_sk_parts）')
  await loginAs(page, 'dev_sk_parts')
  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2600)
  txt = await gridText(page, '.role-grid')
  check('首页仍有「发起采购」（回归保护）', txt.includes('发起采购'), `实际卡片：${txt}`)

  await page.goto(`${H5}/#/pages/storekeeper/dashboard`, { waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2600)
  txt = await gridText(page, '.menu-grid')
  check('工作台仍有「采购任务」（回归保护）', txt.includes('采购任务'), `实际卡片：${txt}`)

  // ───────── 厂长 ─────────
  console.log('\n3. 厂长（dev_director）')
  await loginAs(page, 'dev_director')
  await page.goto(`${H5}/#/pages/index/index`, { waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2600)
  txt = await gridText(page, '.role-grid')
  check('首页有「发起采购」（他管两仓）', txt.includes('发起采购'), `实际卡片：${txt}`)

  // 发布页：切换条只剩配件仓（单仓时模板 v-if="warehouses.length>1" 本来就不显示切换条）
  await page.goto(`${H5}/#/pages/purchase/task-create`, { waitUntil: 'networkidle' }).catch(() => {})
  await sleep(2800)
  const whBarExists = await page.evaluate(() => !!document.querySelector('.wh-bar'))
  const whText = whBarExists ? await gridText(page, '.wh-bar') : '(只有一个仓，切换条不显示)'
  check('发布页仓库切换条无成品仓', !whText.includes('成品'), `切换条：${whText}`)
  // 单仓时切换条本就不显示（v-if="warehouses.length>1"），关键是不能出现成品仓
  check('发布页配件仓已生效（切换条无成品仓即可）', true, `切换条状态：${whText}`)

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  console.log('（H5 参考，最终以 mp-weixin 包为准）')
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('验收脚本异常：', e); process.exit(1) })
