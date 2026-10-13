/**
 * ============================================================
 * 跨端联动真实测试（小程序真模拟器 + 后台真浏览器）
 * ------------------------------------------------------------
 * 用户诉求：不要只看代码，要**真实去操作**两端，重点看实际操作后
 *   「库存数量」与「资产金额（库存×移动加权成本 avg_cost）」会不会出现异常。
 *
 * 覆盖：
 *   A. 小程序端逐角色真实操作（领料员/采购员/仓管/厂长/老板）
 *   B. 后台端逐账号真实操作（配件仓/成品仓/厂长/管理员）逐页巡检
 *   C. 跨端联动：
 *      C1 领料员小程序发起领料 → 配件仓管**后台**确认+拣货 → 领料员小程序确认收货
 *      C2 配件仓管**后台**新建入库单 → 两端核对库存与成本
 *      C3 厂长小程序发起成品仓出库 → 成品仓管**后台**确认+拣货
 *   D. 数据核对：每步前后采 stock / avg_cost / 资产金额，逐项对账
 *
 * ⚠️ 会往真实库写数据（单据/消息/流水），跑完 autoCleanup() 清理并把库存复位。
 * 用法：node tests/role-agent/cross-e2e.js
 * 前提：devtools 自动化端口 9420 已开；后台静态服务 5178 已起；后端 3000 在跑。
 * ============================================================
 */
require('../../src/config/env')

const fs = require('fs')
const path = require('path')
const automator = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator')
let chromium
try { chromium = require('playwright-core').chromium } catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { callRaw, loginDev, loginAdmin, db } = require('./lib')
const { autoCleanup } = require('./_cleanup')

const MP_API = process.env.MP_API || 'http://127.0.0.1:3000'
const WS = process.env.MP_WS || 'ws://localhost:9420'
const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5178/admin'
const MARK = 'CROSS'
const OUT_DIR = path.join(process.cwd(), 'tests/role-agent/results/cross-e2e')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ 记录 */
const checks = []      // 功能/操作断言
const ledger = []      // 数据对账行
const adminErrs = []   // 后台前端报错
const views = []       // 真实使用体验记录

function ok(section, label, pass, detail = '') {
  checks.push({ section, label, pass: !!pass, detail })
  console.log(`${pass ? '  ✅' : '  ❌'} [${section}] ${label}${!pass && detail ? '  ← ' + detail : ''}`)
  return !!pass
}
function note(section, label, detail = '') {
  views.push({ section, label, detail })
  console.log(`  📝 [${section}] ${label}${detail ? ' ｜ ' + detail : ''}`)
}
/** 数据对账：before/after 必须按 expect 变化 */
function reconcile(label, before, after, expect) {
  const keys = Object.keys(expect)
  let pass = true
  const rows = []
  for (const k of keys) {
    const b = Number(before[k]), a = Number(after[k])
    const got = Math.round((a - b) * 1000) / 1000
    const want = Number(expect[k])
    const hit = Math.abs(got - want) < 0.011
    if (!hit) pass = false
    rows.push(`${k}: ${b} → ${a} (Δ${got >= 0 ? '+' : ''}${got}, 期望 ${want >= 0 ? '+' : ''}${want})`)
  }
  ledger.push({ label, pass, expect, before, after, text: rows.join('；') })
  console.log(`${pass ? '  ✅' : '  ❌'} [对账] ${label} ｜ ${rows.join('；')}`)
  return pass
}

/* ------------------------------------------------------------------ 数据快照 */
async function matSnap(id) {
  const r = await db.queryOne(
    'SELECT id, name, unit, warehouse_id, current_stock, avg_cost FROM materials WHERE id = ?', [id])
  if (!r) return null
  const stock = Number(r.current_stock)
  const cost = Number(r.avg_cost)
  return {
    id: r.id, name: r.name, unit: r.unit, warehouse_id: Number(r.warehouse_id),
    stock, cost, value: Math.round(stock * cost * 100) / 100
  }
}
async function whValue(wid) {
  const r = await db.queryOne(
    'SELECT ROUND(COALESCE(SUM(current_stock * avg_cost),0),2) v FROM materials WHERE is_deleted=0 AND warehouse_id=?', [wid])
  return Number(r ? r.v : 0)
}
function pick(before, after, fields) {
  const o = {}
  for (const f of fields) o[f] = { before: before[f], after: after[f] }
  return o
}
/** 构造 reconcile 用的 {before:{},after:{}} */
function cmp(b, a) { return { before: { stock: b.stock, cost: b.cost, value: b.value }, after: { stock: a.stock, cost: a.cost, value: a.value } } }

/* ------------------------------------------------------------------ 小程序工具 */
async function loginAs(mp, openid) {
  const code = await mp.evaluate(async ({ url, oid }) => {
    wx.setStorageSync('sl_dev_openid', oid)
    wx.removeStorageSync('sl_token')
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: `${url}/api/auth`, method: 'POST',
        header: { 'Content-Type': 'application/json' },
        data: { action: 'login', data: { dev_openid: oid } },
        success: (r) => resolve(r.data), fail: (e) => reject(new Error(JSON.stringify(e)))
      })
    })
    if (res && res.code === 0 && res.data && res.data.token) { wx.setStorageSync('sl_token', res.data.token); return 0 }
    return (res && res.code) || -1
  }, { url: MP_API, oid: openid })
  if (code !== 0) throw new Error(`登录 ${openid} 失败 code=${code}`)
  await mp.reLaunch('/pages/index/index')
  await sleep(3200)
}
async function curPath(mp) { const p = await mp.currentPage(); return p.path }
async function shotMp(mp, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const f = path.join(OUT_DIR, `mp-${name}.png`)
  await mp.screenshot({ path: f })
  return f
}
async function tapExact(page, selector, label) {
  const els = await page.$$(selector)
  for (const el of els) {
    const t = ((await el.text()) || '').trim()
    if (t === label) { await el.tap(); return true }
  }
  return false
}
/** 真小程序 picker 选第 idx 项（原生组件点不了滚轮，走 bindchange 处理器） */
async function pickType(mp, idx = 0) {
  const wxmlPath = path.resolve(__dirname, '../../../miniprogram/dist/build/mp-weixin/pages/out/submit.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const m = wxml.match(/<picker[^>]*class="picker[^"]*"[^>]*bindchange="\{\{(\w+)\}\}"/)
    || wxml.match(/<picker[^>]*bindchange="\{\{(\w+)\}\}"[^>]*class="picker/)
  if (!m) return false
  const handler = await mp.evaluate((k) => {
    const cur = getCurrentPages().slice(-1)[0]
    if (!cur) return ''
    if (typeof cur[k] === 'function') return k
    if (cur.data && typeof cur.data[k] === 'string' && typeof cur[cur.data[k]] === 'function') return cur.data[k]
    return ''
  }, m[1])
  if (!handler) return false
  await mp.evaluate(({ n, i }) => {
    const cur = getCurrentPages().slice(-1)[0]
    cur[n]({ detail: { value: i } })
  }, { n: handler, i: idx })
  return true
}

/* ------------------------------------------------------------------ 后台工具 */
function attachErr(page, tag) {
  page.on('pageerror', (e) => adminErrs.push(`${tag} pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') adminErrs.push(`${tag} console: ${m.text().slice(0, 160)}`) })
  page.on('response', (r) => { if (r.status() >= 400) adminErrs.push(`${tag} HTTP ${r.status()} ${r.url().slice(0, 140)}`) })
}
async function adminLogin(page, user, pwd = '123456') {
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* 忽略 */ } })
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[placeholder="用户名"]', user)
  await page.fill('input[placeholder="密码"]', pwd)
  await page.click('.login-btn')
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
  await sleep(1200)
}
async function shotAdmin(page, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const f = path.join(OUT_DIR, `admin-${name}.png`)
  await page.screenshot({ path: f, fullPage: false })
  return f
}
/** 打开后台某路由，返回是否渲染出内容（非空白） */
async function visitAdmin(page, route, tag) {
  const errBefore = adminErrs.length
  await page.goto(`${ADMIN_URL}${route}`, { waitUntil: 'domcontentloaded' })
  await sleep(1800)
  const info = await page.evaluate(() => {
    const main = document.querySelector('.el-main') || document.querySelector('main') || document.body
    const txt = (main.innerText || '').replace(/\s+/g, '')
    const errEl = document.querySelector('.el-message--error, .el-notification--error')
    return {
      len: txt.length,
      errMsg: errEl ? (errEl.innerText || '').trim() : '',
      hasCard: !!document.querySelector('.el-card, .el-table, .el-statistic, .el-menu'),
      sample: txt.slice(0, 50)
    }
  })
  const newErr = adminErrs.length - errBefore
  return { ...info, url: page.url(), newErr }
}

/* ================================================================== 主流程 */
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const report = { startedAt: new Date().toISOString(), checks, ledger, adminErrs, views, scenarios: {} }

  /* ---------------- 0. 基线 ---------------- */
  console.log('\n=== 0. 基线快照 ===')
  const tokSK = await loginDev('dev_sk_parts')
  const tokOut = await loginDev('dev_out')
  const tokDir = await loginDev('dev_director')
  const tokSKGoods = await loginDev('dev_sk_goods')

  // ⚠️ 首次跑踩坑：配件仓「加工板」有 J001-10/11/12 三条重名，按名称匹配会跟错物料，
  //    导致对账对象与实际单据物料不是同一个 → 假故障。改为挑「仓库内名称唯一」的物料。
  const uniqMats = async (wid, n) => {
    const rows = await db.query(
      `SELECT m.id, m.name FROM materials m
        WHERE m.is_deleted = 0 AND m.warehouse_id = ? AND m.current_stock >= 6
          AND (SELECT COUNT(*) FROM materials m2 WHERE m2.is_deleted = 0
                AND m2.warehouse_id = m.warehouse_id AND m2.name = m.name) = 1
        ORDER BY m.id LIMIT ${Number(n)}`, [wid])
    return rows
  }
  const u1 = await uniqMats(1, 2)
  if (u1.length < 2) throw new Error('配件仓缺少名称唯一的可用测试物料')
  const u2 = await uniqMats(2, 1)
  if (!u2.length) throw new Error('成品仓缺少名称唯一的可用测试物料')
  const M1 = u1[0], M2 = u1[1], P1 = u2[0]
  const sM1 = await matSnap(M1.id), sM2 = await matSnap(M2.id), sP1 = await matSnap(P1.id)
  const base1 = await whValue(1), base2 = await whValue(2)
  console.log(`  配件仓料M1 #${sM1.id} ${sM1.name} 库存${sM1.stock} 成本${sM1.cost} 金额${sM1.value}`)
  console.log(`  配件仓料M2 #${sM2.id} ${sM2.name} 库存${sM2.stock} 成本${sM2.cost}`)
  console.log(`  成品仓料P1 #${sP1.id} ${sP1.name} 库存${sP1.stock} 成本${sP1.cost}`)
  console.log(`  仓库资产：配件仓 ¥${base1} ／ 成品仓 ¥${base2}`)
  report.baseline = { M1: sM1, M2: sM2, P1: sP1, wh1Value: base1, wh2Value: base2 }

  /* ---------------- 连接两端 ---------------- */
  const mp = await automator.connect({ wsEndpoint: WS })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  attachErr(page, 'global')

  try {
    /* ================= A. 小程序端逐角色 ================= */
    console.log('\n=== A. 小程序端逐角色真实巡检 ===')
    const roleCards = {
      dev_out: ['领料出库'],
      dev_purchase: ['采购任务'],
      dev_sk_parts: ['仓管工作台', '入库登记'],
      dev_director: ['成品仓出库', '经营看板'],
      dev_boss: ['老板看板']
    }
    for (const [oid, must] of Object.entries(roleCards)) {
      await loginAs(mp, oid)
      const p = await curPath(mp)
      ok('A-小程序', `${oid} 登录后停在首页`, p === 'pages/index/index', `实际 ${p}`)
      const pg = await mp.currentPage()
      const cards = await pg.$$('.role-card')
      let all = ''
      for (const c of cards) all += ((await c.text()) || '').replace(/\s+/g, '')
      const miss = must.filter((t) => !all.includes(t))
      ok('A-小程序', `${oid} 该看的入口在（${must.join('、')}）`, miss.length === 0, `缺 ${miss.join('、')}｜实际 ${all}`)
      note('小程序体验', `${oid} 首页`, `${cards.length} 张卡片：${all.slice(0, 120)}`)
      await shotMp(mp, `home-${oid}`)
    }

    /* ================= C1. 领料员小程序发起 → 仓管后台处理 → 小程序收货 ================= */
    console.log('\n=== C1. 跨端：领料员小程序发起领料 ===')
    let before1 = await matSnap(sM1.id)
    await loginAs(mp, 'dev_out')
    let pg = await mp.currentPage()
    const outCard = await pg.$('.role-card-out')
    const tOut = outCard ? await outCard.tap() : false
    ok('C1', '领料员点「领料出库」卡进入', !!outCard)
    await sleep(3200)
    ok('C1', '进入领料出库页', /pages\/out\/submit/.test(await curPath(mp)), await curPath(mp))
    pg = await mp.currentPage()
    // 搜索 M1 精确点选
    // 搜索：用**完整名称**（该料名称在仓内唯一），确保只命中目标
    const kwInput = await pg.$('.search-input input')
    if (kwInput && sM1.name) { await kwInput.input(sM1.name); await sleep(2500) }
    pg = await mp.currentPage()
    let mats = await pg.$$('.material-item')
    let target = null
    for (const el of mats) {
      // ⚠️ 精确匹配物料名（用 .material-name 节点），避免「扒板」误命中「扒板油」
      const nameEl = await el.$('.material-name')
      const t = nameEl ? ((await nameEl.text()) || '').trim() : ((await el.text()) || '').trim()
      if (t === sM1.name) { target = el; break }
    }
    if (!target && mats.length) target = mats[0]
    ok('C1', '搜到目标物料并加入清单', !!target, `候选 ${mats.length} 条`)
    if (target) await target.tap()
    await sleep(1200)
    pg = await mp.currentPage()
    // 数量设为 2
    const qty = await pg.$('.qty-input')
    if (qty) { await qty.input('2'); await sleep(400) }
    // 选类型（第 0 项：领用）
    const picked = await pickType(mp, 0)
    await sleep(600)
    ok('C1', '在真小程序里选好出库类型', picked)
    pg = await mp.currentPage()
    const pv = await pg.$('.picker-value')
    const pvTxt = pv ? ((await pv.text()) || '').trim() : ''
    ok('C1', '类型回显正常（非「请选择类型」）', !!pvTxt && !pvTxt.includes('请选择'), `回显=${pvTxt}`)
    const submitEl = await pg.$('.btn-submit')
    const dis = submitEl ? await submitEl.attribute('disabled') : 'no-btn'
    ok('C1', '提交按钮可点', String(dis) !== 'true', `disabled=${dis}`)
    await shotMp(mp, 'C1-领料清单')
    if (submitEl && String(dis) !== 'true') await submitEl.tap()
    await sleep(2500)
    // 接口侧确认单子生成
    let latest = null
    for (let i = 0; i < 6 && !latest; i++) {
      const lst = await callRaw('outbound', 'list', { page: 1, pageSize: 5 }, tokOut)
      latest = (lst.data.list || []).find((o) => o.operator_openid === 'dev_out' && o.status === 'pending')
      if (!latest) await sleep(1000)
    }
    ok('C1', '小程序提交后生成待确认出库单', !!latest, latest ? `${latest.order_no} ${latest.items_summary || ''}` : '未查到')
    const orderId = latest && latest._id
    const orderNo = latest && latest.order_no
    report.scenarios.c1 = { orderId, orderNo }
    // ⚠️ 以**单据明细的 material_id** 为对账基准（避免同名/搜索偏差造成假故障）
    if (orderId) {
      const od = await callRaw('outbound', 'detail', { id: orderId }, tokOut)
      const itemMatId = od.data && od.data.items && od.data.items[0] && od.data.items[0].material_id
      const docsQty = od.data && od.data.items && od.data.items[0] && Number(od.data.items[0].quantity)
      ok('C1', '单据明细物料 = 选中的目标料（没选错料）', Number(itemMatId) === Number(sM1.id),
        `单据料 ${itemMatId} / 目标 ${sM1.id}`)
      if (itemMatId) {
        before1 = await matSnap(itemMatId)   // 归一：出库提交不改库存，此刻取到的即提交前值
        report.scenarios.c1.itemMatId = itemMatId
        report.scenarios.c1.qty = docsQty
      }
    }
    const afterSub = await matSnap(before1.id)
    reconcile('C1 发起领料后（未确认，库存不应变）', before1, afterSub, { stock: 0, value: 0 })

    /* ---- C1-b. 仓管在后台确认 + 拣货 ---- */
    console.log('\n=== C1-b. 跨端：配件仓管在【后台】确认 + 拣货 ===')
    await adminLogin(page, 'peijian')
    await shotAdmin(page, 'C1-仓管登录落地')
    await visitAdmin(page, '/order/outbound', 'peijian')
    const foundInList = await page.evaluate((no) => {
      const txt = document.body.innerText || ''
      return txt.includes(no)
    }, orderNo)
    ok('C1-b', '仓管后台出库单列表能看到小程序刚提交的单', foundInList, `找单号 ${orderNo}`)
    // 用单号搜索，避免分页/排序干扰
    const kw = page.locator('input[placeholder="搜索单号"]').first()
    if (await kw.count()) { await kw.fill(orderNo); await page.locator('button:has-text("搜索")').first().click(); await sleep(1800) }
    const row = page.locator('.el-table__row').filter({ hasText: orderNo }).first()
    const rowCnt = await row.count()
    ok('C1-b', '后台按单号搜到该出库单', rowCnt > 0, `行数 ${rowCnt}`)
    await shotAdmin(page, 'C1-仓管待确认单')
    if (rowCnt > 0) {
      await row.locator('button', { hasText: '确认' }).first().click()
      await sleep(1500)
      // Element Plus 确认框（如有）——出库确认一般无二次框，兜底点确定
      const confirmBtn = page.locator('.el-message-box__btns button:has-text("确定")')
      if (await confirmBtn.count()) { await confirmBtn.first().click(); await sleep(1500) }
      await sleep(1000)
      const st1 = await callRaw('outbound', 'detail', { id: orderId }, tokSK)
      ok('C1-b', '仓管后台点「确认」→ 单据进入待拣货', st1.data && st1.data.status === 'picking', `status=${st1.data && st1.data.status}`)
      const afterConf = await matSnap(before1.id)
      reconcile('C1-b 仓管确认后（仍未扣库存）', before1, afterConf, { stock: 0, value: 0 })
      // 拣货完成
      await visitAdmin(page, '/order/outbound', 'peijian')
      const row2 = page.locator('.el-table__row').filter({ hasText: orderNo }).first()
      if (await row2.count()) {
        await row2.locator('button', { hasText: '拣货完成' }).first().click()
        await sleep(1500)
        const cf2 = page.locator('.el-message-box__btns button:has-text("确定")')
        if (await cf2.count()) { await cf2.first().click(); await sleep(1200) }
        const st2 = await callRaw('outbound', 'detail', { id: orderId }, tokSK)
        ok('C1-b', '仓管后台点「拣货完成」→ 单据进入待收货', st2.data && st2.data.status === 'receiving', `status=${st2.data && st2.data.status}`)
        const afterPick = await matSnap(before1.id)
        reconcile('C1-b 拣货完成后（仍未扣库存）', before1, afterPick, { stock: 0, value: 0 })
      } else {
        ok('C1-b', '后台列表能定位到已确认的单以执行拣货', false, '行定位失败')
      }
    }

    /* ---- C1-c. 领料员小程序收到通知 → 确认收货（扣库存） ---- */
    console.log('\n=== C1-c. 跨端：领料员小程序确认收货（真正扣库存） ===')
    await loginAs(mp, 'dev_out')
    await mp.navigateTo('/pages/message/list')
    await sleep(2500)
    pg = await mp.currentPage()
    const msgBox = await pg.$('.msg-list, .message-list, .container')
    const bodyTxt = msgBox ? ((await msgBox.text()) || '') : ''
    ok('C1-c', '领料员小程序消息中心能收到拣货通知', /拣货|收货|领料/.test(bodyTxt || ''), (bodyTxt || '').slice(0, 80))
    await shotMp(mp, 'C1-领料员消息中心')
    await mp.navigateTo(`/pages/out/detail?id=${orderId}`)
    await sleep(2500)
    pg = await mp.currentPage()
    const recvBtn = await pg.$('.btn-receive')
    ok('C1-c', '出库详情页出现「确认收货」入口', !!recvBtn)
    await shotMp(mp, 'C1-领料员待收货详情')
    // uni.showModal 是原生弹窗 automator 点不了 → 用接口走完最后一步（与既有回归惯例一致）
    const recv = await callRaw('outbound', 'receive', { id: orderId }, tokOut)
    ok('C1-c', '确认收货成功', recv.code === 0, `code=${recv.code} ${recv.message || ''}`)
    const det = await callRaw('outbound', 'detail', { id: orderId }, tokOut)
    ok('C1-c', '单据已完成且标记已扣库存', det.data && det.data.status === 'completed' && Number(det.data.stock_deducted) === 1,
      `status=${det.data && det.data.status} deducted=${det.data && det.data.stock_deducted}`)
    const qty1 = report.scenarios.c1.qty || 2
    const afterRecv = await matSnap(before1.id)
    reconcile('C1-c 确认收货后（库存应减少）', before1, afterRecv, { stock: -qty1, value: -Math.round(qty1 * before1.cost * 100) / 100 })
    // 流水核对（按单据真实物料）
    const logRow = await db.queryOne(
      "SELECT change_type, change_quantity, before_stock, after_stock FROM stock_logs WHERE related_order_id = ? AND material_id = ? LIMIT 1",
      [orderNo, before1.id])
    if (logRow) {
      ok('C1-c', '库存流水记录的变动量与单据一致',
        Number(logRow.change_quantity) === -qty1 && Number(logRow.after_stock) === afterRecv.stock,
        `流水 Δ${logRow.change_quantity} ${logRow.before_stock}→${logRow.after_stock}，单据 qty=${qty1}`)
    } else {
      ok('C1-c', '库存流水有对应记录', false, '未找到流水')
    }

    /* ================= C2. 仓管后台新建入库单 ================= */
    console.log('\n=== C2. 跨端：配件仓管在【后台】新建入库单（提交即入库） ===')
    const before2 = await matSnap(sM2.id)
    const whBefore = await whValue(1)
    await adminLogin(page, 'peijian')
    await visitAdmin(page, '/order/inbound-create', 'peijian')
    const pageTxt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ''))
    ok('C2', '后台「新建入库单」页正常打开', pageTxt.includes('新建入库单'))
    // 搜索 M2 并加入清单
    const mkw = page.locator('input[placeholder="搜索物料名称 / 规格 / 编号"]').first()
    if (await mkw.count()) { await mkw.fill(sM2.name); await sleep(2000) }
    const mrow = page.locator('.el-table__row').filter({ hasText: sM2.name }).first()
    let mrowCnt = await mrow.count()
    let useRow = mrow
    if (!mrowCnt) { useRow = page.locator('.el-table__row').first(); mrowCnt = await useRow.count() }
    ok('C2', '后台搜到目标物料', mrowCnt > 0, `行 ${mrowCnt}`)
    if (mrowCnt > 0) {
      await useRow.locator('button', { hasText: '加入' }).first().click()
      await sleep(1000)
      // 读清单里加入的物料 id（用于对账），并设数量=5、单价=8
      const numInputs = page.locator('.inner-card .el-input-number input')
      const n = await numInputs.count()
      ok('C2', '清单出现数量/单价输入框', n >= 2, `输入框 ${n}`)
      if (n >= 2) {
        await numInputs.nth(0).fill('5'); await numInputs.nth(0).blur(); await sleep(400)
        await numInputs.nth(1).fill('8'); await numInputs.nth(1).blur(); await sleep(400)
      }
      await shotAdmin(page, 'C2-后台新建入库单已填')
      const subBtn = page.locator('button:has-text("提交入库单")').first()
      const subDis = await subBtn.isDisabled().catch(() => false)
      ok('C2', '提交按钮可用', !subDis)
      if (!subDis) {
        await subBtn.click()
        await sleep(2500)
        const msg = await page.evaluate(() => {
          const m = document.querySelector('.el-message, .el-message--success, .el-message--error')
          return m ? m.innerText : ''
        })
        note('后台体验', '新建入库单提交反馈', msg || '(未捕获提示)')
        const afterIn = await matSnap(sM2.id)
        // 单据明细校验（确认后台清单里加的就是目标料）
        const lastIn = await db.queryOne(
          'SELECT i.material_id, i.quantity, i.unit_price FROM inbound_orders o JOIN inbound_order_items i ON i.order_id = o.id ORDER BY o.id DESC LIMIT 1')
        const inQty = lastIn ? Number(lastIn.quantity) : 5
        ok('C2', '入库单明细物料 = 选中的目标料（没选错料）',
          lastIn && Number(lastIn.material_id) === Number(sM2.id),
          `单据料 ${lastIn && lastIn.material_id} / 目标 ${sM2.id}；数量 ${inQty} 单价 ${lastIn && lastIn.unit_price}`)
        // 提交即入库：库存 +5
        reconcile('C2 后台提交入库后（库存应 +' + inQty + '）', before2, afterIn, { stock: inQty })
        const whAfter = await whValue(1)
        const dVal = Math.round((whAfter - whBefore) * 100) / 100
        ledger.push({ label: 'C2 配件仓资产总额变化', pass: Math.abs(dVal - (afterIn.value - before2.value)) < 0.5, expect: '±(单料金额变化)', before: { v: whBefore }, after: { v: whAfter }, text: `仓库 ${whBefore} → ${whAfter} (Δ${dVal})；单料金额 ${before2.value} → ${afterIn.value}` })
        console.log(`  ${Math.abs(dVal - (afterIn.value - before2.value)) < 0.5 ? '✅' : '❌'} [对账] C2 仓库资产变化与单料一致 Δ${dVal}`)
        note('后台体验', '入库后成本', `${sM2.name} avg_cost ${before2.cost} → ${afterIn.cost}`)
        // 专项：入库「提交即入账」但单据状态仍是 pending（后台文案说"等待确认"）→ 记入发现
        const inOrd = await db.queryOne('SELECT status FROM inbound_orders ORDER BY id DESC LIMIT 1')
        if (inOrd && inOrd.status !== 'completed' && afterIn.stock !== before2.stock) {
          note('⚠️发现', '入库单状态与库存不一致',
            `单状态=${inOrd.status}（后台提示「已提交，等待确认」），但库存已 ${before2.stock} → ${afterIn.stock}（提交即入账）；文案易让仓管误以为尚未入库而重复操作`)
        }
        report.scenarios.c2 = { M2: sM2.name, before: before2, after: afterIn, orderStatus: inOrd && inOrd.status }
      }
    }

    /* ================= C3. 厂长小程序发起成品仓出库 → 成品仓管后台 ================= */
    console.log('\n=== C3. 跨端：厂长小程序发起成品仓出库 → 成品仓管后台处理 ===')
    let beforeP = await matSnap(sP1.id)
    await loginAs(mp, 'dev_director')
    pg = await mp.currentPage()
    const foCard = await pg.$('.role-card-finishout')
    ok('C3', '厂长首页有「成品仓出库」卡', !!foCard)
    if (foCard) {
      await foCard.tap()
      await sleep(3200)
      ok('C3', '进入成品仓出库页', /pages\/out\/submit/.test(await curPath(mp)), await curPath(mp))
      pg = await mp.currentPage()
      const whBar = await pg.$$('.wh-bar')
      ok('C3', '仓库被锁死（无切仓条）', whBar.length === 0, `wh-bar=${whBar.length}`)
      const kwd = await pg.$('.search-input input')
      if (kwd && sP1.name) { await kwd.input(sP1.name); await sleep(2500) }
      pg = await mp.currentPage()
      let pmats = await pg.$$('.material-item')
      let pt = null
      for (const el of pmats) {
        const nameEl = await el.$('.material-name')
        const t = nameEl ? ((await nameEl.text()) || '').trim() : ((await el.text()) || '').trim()
        if (t === sP1.name) { pt = el; break }
      }
      if (!pt && pmats.length) pt = pmats[0]
      ok('C3', '成品仓物料可加入清单', !!pt, `候选 ${pmats.length}`)
      if (pt) await pt.tap()
      await sleep(1000)
      const q2 = await pg.$('.qty-input')
      if (q2) { await q2.input('1'); await sleep(400) }
      const pk2 = await pickType(mp, 0)
      await sleep(600)
      ok('C3', '厂长在真小程序选好出库类型', pk2)
      pg = await mp.currentPage()
      const sb2 = await pg.$('.btn-submit')
      const d2 = sb2 ? await sb2.attribute('disabled') : 'no-btn'
      ok('C3', '厂长提交按钮可点', String(d2) !== 'true', `disabled=${d2}`)
      await shotMp(mp, 'C3-厂长成品仓出库')
      if (sb2 && String(d2) !== 'true') await sb2.tap()
      await sleep(2500)
      let latestP = null
      for (let i = 0; i < 6 && !latestP; i++) {
        const l = await callRaw('outbound', 'list', { page: 1, pageSize: 5 }, tokDir)
        latestP = (l.data.list || []).find((o) => o.operator_openid === 'dev_director' && o.status === 'pending')
        if (!latestP) await sleep(1000)
      }
      ok('C3', '厂长提交后生成待确认出库单', !!latestP, latestP ? latestP.order_no : '未查到')
      if (latestP) {
        const odP = await callRaw('outbound', 'detail', { id: latestP._id }, tokDir)
        const pMatId = odP.data && odP.data.items && odP.data.items[0] && odP.data.items[0].material_id
        ok('C3', '成品仓出库单明细物料 = 选中的目标料（没选错料）',
          Number(pMatId) === Number(sP1.id), `单据料 ${pMatId} / 目标 ${sP1.id}`)
        if (pMatId) beforeP = await matSnap(pMatId)
        // 成品仓管在后台处理
        await adminLogin(page, 'chengpin')
        await visitAdmin(page, '/order/outbound', 'chengpin')
        const kw3 = page.locator('input[placeholder="搜索单号"]').first()
        if (await kw3.count()) { await kw3.fill(latestP.order_no); await page.locator('button:has-text("搜索")').first().click(); await sleep(1800) }
        const r3 = page.locator('.el-table__row').filter({ hasText: latestP.order_no }).first()
        ok('C3', '成品仓管后台能看到厂长的成品仓出库单', (await r3.count()) > 0)
        await shotAdmin(page, 'C3-成品仓管待确认')
        if (await r3.count()) {
          await r3.locator('button', { hasText: '确认' }).first().click(); await sleep(1500)
          const cf3 = page.locator('.el-message-box__btns button:has-text("确定")')
          if (await cf3.count()) { await cf3.first().click(); await sleep(1200) }
          const st3 = await callRaw('outbound', 'detail', { id: latestP._id }, tokSKGoods)
          ok('C3', '成品仓管后台确认 → 待拣货', st3.data && st3.data.status === 'picking', `status=${st3.data && st3.data.status}`)
          const afterP1 = await matSnap(beforeP.id)
          reconcile('C3 成品仓管确认后（未扣库存）', beforeP, afterP1, { stock: 0, value: 0 })
          report.scenarios.c3 = { orderNo: latestP.order_no, id: latestP._id, itemMatId: pMatId }
        }
      }
    }

    /* ================= B. 后台逐账号逐页巡检 ================= */
    console.log('\n=== B. 后台逐账号逐页真实巡检 ===')
    const tours = {
      peijian: ['/dashboard', '/material/parts', '/order/outbound', '/order/inbound', '/order/inbound-create', '/order/purchase-tasks', '/message/list', '/check/list'],
      chengpin: ['/dashboard', '/material/product', '/order/outbound', '/order/inbound', '/order/purchase-tasks', '/message/list'],
      changzhang: ['/dashboard', '/material/parts', '/material/product', '/order/outbound', '/order/outbound-create', '/order/purchase-tasks', '/message/list', '/check/list'],
      admin: ['/dashboard', '/stats/overview', '/user/list', '/material/list', '/order/outbound', '/order/inbound', '/order/inbound-create', '/order/outbound-create', '/order/purchase-tasks', '/message/list', '/check/list', '/system/logs']
    }
    for (const [user, routes] of Object.entries(tours)) {
      await adminLogin(page, user)
      for (const r of routes) {
        const v = await visitAdmin(page, r, user)
        // 空状态页（如「暂时没有消息」）文本天然短，只要主容器与结构渲染出来就算正常
        const renderOk = v.len > 20 && v.hasCard && !v.errMsg
        ok('B-后台', `${user} 打开 ${r}`, renderOk, `文本${v.len} 结构=${v.hasCard} 错误提示="${v.errMsg}" 片段="${v.sample}"`)
        if (r === '/dashboard') await shotAdmin(page, `B-${user}-首页`)
      }
    }
    // 越权：成品仓管不该进「新建出库单」（厂长专属）
    await adminLogin(page, 'chengpin')
    const vGate = await visitAdmin(page, '/order/outbound-create', 'chengpin')
    const bounced = !page.url().includes('/order/outbound-create')
    ok('B-越权', '成品仓管访问厂长专属「新建出库单」被拦（弹回自己首页）', bounced, `最终 url=${page.url()}`)
    const menuHas = await page.evaluate(() => (document.body.innerText || '').includes('新建出库单'))
    ok('B-越权', '成品仓管菜单里没有「新建出库单」', !menuHas)
    note('后台体验', '成品仓管越权', `访问 /order/outbound-create → ${page.url()}（弹回=${bounced}）`)

    /* ================= D. 数据一致性：两端显示金额 vs 数据库 ================= */
    console.log('\n=== D. 数据一致性：后台/小程序显示金额 vs 数据库 ===')
    // D1 后台看板
    await adminLogin(page, 'peijian')
    await visitAdmin(page, '/dashboard', 'peijian')
    const dashTxt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
    // ⚠️ 页面结构是「金额在上、标题在下」：如 "¥1,990,518.4 库存价值"
    const mVal = dashTxt.match(/¥\s*([\d,]+\.?\d*)\s*库存价值/)
    const dbWh1 = await whValue(1)
    if (mVal) {
      const shown = Number(mVal[1].replace(/,/g, ''))
      const same = Math.abs(shown - dbWh1) < 1
      ledger.push({ label: 'D1 后台看板「库存价值」vs 数据库（配件仓）', pass: same, expect: '一致', before: { db: dbWh1 }, after: { shown }, text: `后台 ¥${shown} / DB ¥${dbWh1}` })
      ok('D-一致性', `后台看板库存价值 ¥${shown} = 数据库 ¥${dbWh1}`, same, `后台 ¥${shown} / DB ¥${dbWh1}`)
    } else {
      note('D-一致性', '后台看板金额', `未匹配到金额文本，片段：${dashTxt.slice(0, 80)}`)
    }
    // D2 小程序厂长看板（两仓）
    await loginAs(mp, 'dev_director')
    await mp.navigateTo('/pages/boss/dashboard')
    await sleep(3200)
    const dpage = await mp.currentPage()
    const dashEl = await dpage.$('.container')
    const dTxt = dashEl ? ((await dashEl.text()) || '').replace(/\s+/g, '') : ''
    await shotMp(mp, 'D-厂长经营看板')
    const totalDb = Math.round(((await whValue(1)) + (await whValue(2))) * 100) / 100
    note('D-一致性', '厂长看板页面文本', dTxt.slice(0, 200))
    // ⚠️ 小程序看板按「万」为单位展示（如 ¥217.36万），要换算后再比
    const mWan = dTxt.match(/仓库总值合计\s*¥?\s*([\d.]+)\s*万/)
    const mWh1 = dTxt.match(/配件仓库存\s*\d+·\d+种物料\s*¥?\s*([\d.]+)\s*万/)
    const mWh2 = dTxt.match(/成品仓库存\s*\d+·\d+种物料\s*¥?\s*([\d.]+)\s*万/)
    const shownTotal = mWan ? Math.round(Number(mWan[1]) * 10000 * 100) / 100 : null
    const dbWh1v = await whValue(1), dbWh2v = await whValue(2)
    if (shownTotal !== null) {
      const dSame = Math.abs(shownTotal - totalDb) < 100
      ledger.push({ label: 'D2 小程序厂长看板「仓库总值合计」vs 数据库', pass: dSame, expect: '一致（万位舍入）', before: { db: totalDb }, after: { shown: shownTotal }, text: `小程序 ¥${shownTotal}（${mWan[1]}万）/ DB ¥${totalDb}` })
      ok('D-一致性', `厂长看板「仓库总值合计」¥${shownTotal} ≈ 数据库两仓合计 ¥${totalDb}`, dSame, `页面 ${mWan[1]}万 / DB ${totalDb}`)
      if (mWh1) {
        const s1 = Math.round(Number(mWh1[1]) * 10000 * 100) / 100
        ok('D-一致性', `厂长看板「配件仓」金额 ¥${s1} ≈ 数据库 ¥${dbWh1v}`, Math.abs(s1 - dbWh1v) < 100, `页面 ${mWh1[1]}万 / DB ${dbWh1v}`)
      }
      if (mWh2) {
        const s2 = Math.round(Number(mWh2[1]) * 10000 * 100) / 100
        ok('D-一致性', `厂长看板「成品仓」金额 ¥${s2} ≈ 数据库 ¥${dbWh2v}`, Math.abs(s2 - dbWh2v) < 100, `页面 ${mWh2[1]}万 / DB ${dbWh2v}`)
      }
    } else {
      note('D-一致性', '厂长看板金额', '未匹配到「仓库总值合计」，跳过数值比对')
    }
  } finally {
    try { await mp.disconnect() } catch (e) { /* 忽略 */ }
    await browser.close()
  }

  /* ---------------- 汇总 ---------------- */
  const passN = checks.filter((c) => c.pass).length
  const failN = checks.length - passN
  const ledPass = ledger.filter((l) => l.pass).length
  report.finishedAt = new Date().toISOString()
  report.summary = { total: checks.length, pass: passN, fail: failN, ledgerTotal: ledger.length, ledgerPass: ledPass, adminErrCount: adminErrs.length }
  fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`\n========== 跨端真实测试：功能 ${passN}/${checks.length} ｜ 对账 ${ledPass}/${ledger.length} ｜ 后台前端报错 ${adminErrs.length} ==========`)
  if (failN) { console.log('失败项：'); checks.filter((c) => !c.pass).forEach((c) => console.log(`  ❌ [${c.section}] ${c.label} ← ${c.detail}`)) }
  return failN
}

let exitCode = 1
main().then((f) => { exitCode = f ? 1 : 0 })
  .catch((e) => { console.error('套件异常：', e); exitCode = 1 })
  .finally(async () => { await autoCleanup(); process.exit(exitCode) })
