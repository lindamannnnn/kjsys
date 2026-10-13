/**
 * 仓管金额隐藏 —— 后台**真浏览器**验收
 * ============================================================
 * 与 money-mask-check.js 的分工：
 *   money-mask-check.js  验**后端真防线**（接口里根本没有金额字段）
 *   本脚本               验**前端展示层**（页面上真的看不到那些列 / 卡片）
 *
 * 断言（成品仓管整片收口，配件仓保留入库单价）：
 *   成品仓管 chengpin  /dashboard       → 无「库存价值」KPI
 *   成品仓管 chengpin  /stats/overview  → 单据流水无「金额」、台账无「成本价/库存价值」、仓库对比无「库存价值」
 *   成品仓管 chengpin  /order/inbound   → 无「总金额」列
 *   配件仓管 peijian   /order/inbound   → **有**「总金额」列（配件仓保留）
 *   配件仓管 peijian   /stats/overview  → 单据流水**有**「金额」（配件仓入库单）
 *   厂长    changzhang /dashboard       → 有「库存价值」
 *   管理员  admin      /stats/overview  → 台账有「成本价」「库存价值」
 *
 * ⚠️ 「按仓库区分」必须**有数据**才看得出来 → 本脚本先建 2 张入库单
 *   （配件仓 / 成品仓各 1），跑完在 finally 里清理（单据/明细/流水/消息 + 库存成本复位）。
 *
 * 用法：node tests/role-agent/money-mask-ui-check.js
 * 前提：后台静态服务已起（默认 http://127.0.0.1:5179/admin）、后端 3000 在跑
 * 产物：tests/role-agent/results/money-mask/*.png
 * ============================================================
 */
require('../../src/config/env')
const fs = require('fs')
const path = require('path')
const { callRaw, loginDev } = require('./lib')
const { query, queryOne, execute } = require('../../src/db/pool')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5179/admin'
const OUT_DIR = path.join(process.cwd(), 'tests/role-agent/results/money-mask')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅', label)
  } else {
    fail++
    failures.push(`${label}${detail ? ' :: ' + detail : ''}`)
    console.log('  ❌', label, detail)
  }
}

async function api(token, mod, action, data = {}) {
  const r = await callRaw(mod, action, data, token)
  if (!r || r.code !== 0) throw new Error(`${mod}.${action} 失败：${r && r.message}`)
  return r.data
}

async function adminLogin(page, user, pwd = '123456') {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* ignore */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', user)
  await page.fill('input[placeholder="密码"]', pwd)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)
}

/** 表头文字（去重） */
async function readHeaders(page) {
  return page.evaluate(() => {
    const ths = [...document.querySelectorAll('.el-table__header th, .el-table__header-wrapper th')]
    return [...new Set(ths.map((th) => (th.innerText || '').replace(/\s+/g, '')).filter(Boolean))]
  })
}

/** 页面可见文字（用于找 KPI 卡片这类非表头内容） */
async function readText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ''))
}

async function goto(page, route, tag, waitTable = true) {
  await page.goto(`${ADMIN_URL}${route}`, { waitUntil: 'domcontentloaded' })
  if (waitTable) await page.waitForFunction(() => !!document.querySelector('.el-table__header th'), null, { timeout: 15000 }).catch(() => {})
  await sleep(1000)
  if (tag) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) })
  }
}

/** 切换 el-tabs 的某个 tab */
async function switchTab(page, label) {
  const found = await page.evaluate((lb) => {
    const tabs = [...document.querySelectorAll('.el-tabs__item')]
    const t = tabs.find((x) => (x.innerText || '').trim() === lb)
    if (!t) return false
    t.click()
    return true
  }, label)
  await sleep(1200)
  return found
}

async function main() {
  console.log('\n═══ 仓管金额隐藏 · 真浏览器验收 ═══')
  console.log(`后台地址：${ADMIN_URL}\n`)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ---------- 1. 造数（按仓库区分必须要有数据才看得出来）----------
  console.log('【准备】建 2 张入库单（配件仓 / 成品仓）')
  const whs = await query('SELECT id, code, name FROM warehouses WHERE is_deleted = 0 ORDER BY id')
  const whParts = whs.find((w) => w.code === 'peijian')
  const whGoods = whs.find((w) => w.code === 'chengpin')
  const matParts = await queryOne('SELECT id, current_stock, avg_cost FROM materials WHERE warehouse_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1', [whParts.id])
  const matGoods = await queryOne('SELECT id, current_stock, avg_cost FROM materials WHERE warehouse_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1', [whGoods.id])

  const baseLogId = Number((await queryOne('SELECT COALESCE(MAX(id), 0) AS m FROM stock_logs')).m)
  const baseMsgId = Number((await queryOne('SELECT COALESCE(MAX(id), 0) AS m FROM messages')).m)
  const baseStock = { [matParts.id]: Number(matParts.current_stock), [matGoods.id]: Number(matGoods.current_stock) }
  const baseCost = { [matParts.id]: Number(matParts.avg_cost), [matGoods.id]: Number(matGoods.avg_cost) }

  let ids = []
  let browser = null

  try {
    const tParts = await loginDev('dev_sk_parts')
    const tGoods = await loginDev('dev_sk_goods')
    const inParts = await api(tParts, 'inbound', 'submit', {
      items: [{ material_id: matParts.id, quantity: 1, unit_price: 30 }],
      supplier: 'MASK-UI验收', warehouse_id: whParts.id
    })
    const inGoods = await api(tGoods, 'inbound', 'submit', {
      items: [{ material_id: matGoods.id, quantity: 1, unit_price: 50 }],
      supplier: 'MASK-UI验收', warehouse_id: whGoods.id
    })
    ids = [Number(inParts._id), Number(inGoods._id)]
    console.log(`      配件仓单 #${ids[0]}｜成品仓单 #${ids[1]}\n`)

    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    const page = await ctx.newPage()

    // ---------- 2. 成品仓管：全面收口 ----------
    console.log('\n[chengpin 成品仓管] /dashboard')
    await adminLogin(page, 'chengpin')
    await goto(page, '/dashboard', '成品仓管-数据看板', false)
    let text = await readText(page)
    check('成品仓管 看板【无】「库存价值」KPI', !text.includes('库存价值'))
    check('成品仓管 看板仍保留「库存总量」（只收钱不收数量）', text.includes('库存总量'))

    console.log('\n[chengpin 成品仓管] /stats/overview')
    await goto(page, '/stats/overview', '成品仓管-出入库统计')
    // 仓管默认落在「单据流水」
    let heads = await readHeaders(page)
    console.log(`  单据流水表头：${heads.join(' | ')}`)
    check('成品仓管 单据流水【无】「金额」列', !heads.includes('金额'))

    const okTab1 = await switchTab(page, '库存台账')
    if (okTab1) {
      heads = await readHeaders(page)
      console.log(`  库存台账表头：${heads.join(' | ')}`)
      check('成品仓管 库存台账【无】「成本价」列', !heads.includes('成本价'))
      check('成品仓管 库存台账【无】「库存价值」列', !heads.includes('库存价值'))
      check('成品仓管 库存台账仍保留「当前库存」列', heads.includes('当前库存'))
      await page.screenshot({ path: path.join(OUT_DIR, '成品仓管-库存台账.png') })
    } else {
      check('成品仓管 能切到「库存台账」tab', false, '未找到 tab')
    }

    const okTab2 = await switchTab(page, '仓库对比')
    if (okTab2) {
      heads = await readHeaders(page)
      console.log(`  仓库对比表头：${heads.join(' | ')}`)
      check('成品仓管 仓库对比【无】「库存价值」列', !heads.includes('库存价值'))
      check('成品仓管 仓库对比仍保留「库存总量」列', heads.includes('库存总量'))
      await page.screenshot({ path: path.join(OUT_DIR, '成品仓管-仓库对比.png') })
    } else {
      check('成品仓管 能切到「仓库对比」tab', false, '未找到 tab')
    }

    console.log('\n[chengpin 成品仓管] /order/inbound')
    await goto(page, '/order/inbound', '成品仓管-入库单')
    heads = await readHeaders(page)
    console.log(`  入库单表头：${heads.join(' | ')}`)
    check('成品仓管 入库单【无】「总金额」列（成品仓不保留）', !heads.includes('总金额'))
    check('成品仓管 入库单仍保留「总数量」列', heads.includes('总数量'))

    // ---------- 3. 配件仓管：入库单价保留 ----------
    console.log('\n[peijian 配件仓管] /order/inbound')
    await adminLogin(page, 'peijian')
    await goto(page, '/order/inbound', '配件仓管-入库单')
    heads = await readHeaders(page)
    console.log(`  入库单表头：${heads.join(' | ')}`)
    check('配件仓管 入库单【有】「总金额」列（配件仓保留，对账用）', heads.includes('总金额'))

    console.log('\n[peijian 配件仓管] /dashboard')
    await goto(page, '/dashboard', '配件仓管-数据看板', false)
    text = await readText(page)
    check('配件仓管 看板【无】「库存价值」KPI（库存价值对仓管一律收）', !text.includes('库存价值'))

    console.log('\n[peijian 配件仓管] /stats/overview')
    await goto(page, '/stats/overview', '配件仓管-出入库统计')
    heads = await readHeaders(page)
    console.log(`  单据流水表头：${heads.join(' | ')}`)
    check('配件仓管 单据流水【有】「金额」列（配件仓入库单保留）', heads.includes('金额'))

    // ---------- 4. 对照组：厂长 / 管理员应该照常看到 ----------
    console.log('\n[changzhang 厂长] /dashboard')
    await adminLogin(page, 'changzhang')
    await goto(page, '/dashboard', '厂长-数据看板', false)
    text = await readText(page)
    check('厂长 看板【有】「库存价值」KPI', text.includes('库存价值'))

    console.log('\n[admin 管理员] /stats/overview')
    await adminLogin(page, 'admin')
    await goto(page, '/stats/overview', '管理员-出入库统计')
    const okTab3 = await switchTab(page, '库存台账')
    if (okTab3) {
      heads = await readHeaders(page)
      console.log(`  库存台账表头：${heads.join(' | ')}`)
      check('管理员 库存台账【有】「成本价」列', heads.includes('成本价'))
      check('管理员 库存台账【有】「库存价值」列', heads.includes('库存价值'))
      await page.screenshot({ path: path.join(OUT_DIR, '管理员-库存台账.png') })
    } else {
      check('管理员 能切到「库存台账」tab', false, '未找到 tab')
    }

    await goto(page, '/order/inbound', '管理员-入库单')
    heads = await readHeaders(page)
    console.log(`  管理员 入库单表头：${heads.join(' | ')}`)
    check('管理员 入库单【有】「总金额」列', heads.includes('总金额'))
  } catch (e) {
    fail++
    failures.push(`执行异常：${e.message}`)
    console.log(`\n  ❌ 执行异常：${e.message}\n${e.stack}`)
  } finally {
    if (browser) await browser.close().catch(() => {})

    // ---------- 5. 清理 ----------
    console.log('\n【清理】')
    if (ids.length) {
      const ph = ids.map(() => '?').join(',')
      await execute(`DELETE FROM inbound_order_items WHERE order_id IN (${ph})`, ids)
      await execute(`DELETE FROM inbound_orders WHERE id IN (${ph})`, ids)
    }
    const logDel = await execute('DELETE FROM stock_logs WHERE id > ?', [baseLogId])
    const msgDel = await execute('DELETE FROM messages WHERE id > ?', [baseMsgId])
    for (const mid of Object.keys(baseStock)) {
      await execute('UPDATE materials SET current_stock = ?, avg_cost = ? WHERE id = ?',
        [baseStock[mid], baseCost[mid], Number(mid)])
    }
    console.log(`      单据 ${ids.length} 张、流水 ${logDel.affectedRows ?? '-'} 条、消息 ${msgDel.affectedRows ?? '-'} 条已清；库存与成本已复位`)

    console.log('\n───────────────────────────────')
    console.log(`通过 ${pass} / 共 ${pass + fail}`)
    console.log(`截图：${OUT_DIR}`)
    if (fail) {
      console.log('\n失败项：')
      failures.forEach((f) => console.log('  ·', f))
      process.exitCode = 1
    } else {
      console.log('全部通过 ✅')
    }
  }
}

main().catch((err) => {
  console.error('运行异常：', err && err.message)
  process.exitCode = 1
})
