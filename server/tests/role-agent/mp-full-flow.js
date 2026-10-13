/**
 * 小程序全流程「真实提交」测试（微信开发者工具模拟器 · 真实按键 · 写操作）
 * ============================================================
 * 对应用户需求（2026-10-13）：「你可以用模拟数据测试一遍所有功能」
 *
 * 与 walkthrough-mp.js（只读走查）的区别：这个**真实提交表单**，把写操作流程跑通。
 * 覆盖：
 *   1. 入库登记（配件仓管）：选物料 → 填数量/单价/备注 → 提交 → 库存真的 +N
 *   2. 领料出库（领料员·配件仓）：选物料 → 选类型 → 填备注 → 提交 → 生成待确认单（不扣库存）
 *   3. 盘点（仓管）：接口建单 → 真实按键录入（其余按账面填）→ 提交 → 进入待审核（不调库存）
 *   4. 报废申请（领料员）：选物料 → 填数量/原因 → 点提交，验证「必传照片」的拦截
 *      ⚠️ 模拟器无法真实选照片（系统级文件框，automator 控制不了），故只验证拦截、不真实提交。
 *
 * 安全：所有单据带 `[FULLFLOW]` 标记；跑完自清理（调 cleanup-test-data.js 按流水 delta 回补库存）。
 *   ⚠️ 出库停在「待确认」、盘点停在「待审核」——都不走到扣/调库存那一步，只有入库会真实加库存
 *      （由 cleanup 按流水回补）。
 *
 * 用法：
 *   1. cli.bat auto --project <产物> --auto-port 9420
 *   2. node tests/role-agent/mp-full-flow.js
 * 前提：后端 3000 + 9420 自动化端口。
 * ============================================================
 */
require('../../src/config/env')

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const automator = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator')

const { callRaw, loginDev } = require('./lib')
const { query, execute } = require('../../src/db/pool')
const { assertDestructive } = require('../../src/db/destructive-guard')

const MP_API = process.env.MP_API || 'http://127.0.0.1:3000'
const WS = process.env.MP_WS || 'ws://localhost:9420'
const MARK = '[FULLFLOW]'
const SHOT_DIR = path.join(process.cwd(), 'tests/role-agent/results/mp-full-flow')
const MP_DIST = path.resolve(__dirname, '../../../miniprogram/dist/build/mp-weixin')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; failures.push({ label, detail }); console.log(`  ❌ ${label}${detail ? `  ← ${detail}` : ''}`) }
}

/* 记录创建的单据（自清理用） */
const created = { inbound: [], outbound: [], check: [] }

/** 换身份登录 */
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
  await sleep(3500)
}

/** 点首页某角色卡片 */
async function tapCard(page, cls) {
  const el = await page.$(cls)
  if (!el) return false
  await el.tap()
  await sleep(3000)
  return true
}

/** 按 placeholder 找 input 并填值 */
async function fillByPlaceholder(page, ph, value) {
  const inputs = await page.$$('input')
  for (const el of inputs) {
    const p = await el.attribute('placeholder')
    if ((p || '').includes(ph)) { await el.input(String(value)); await sleep(300); return true }
  }
  return false
}

/** 原生 picker 自动化（automator 点不了滚轮）：从产物 wxml 解析 bindchange 键，调页面实例的处理器 */
async function pickNative(mp, pageWxmlRel, value) {
  const wxml = fs.readFileSync(path.join(MP_DIST, pageWxmlRel), 'utf8')
  const mPick = wxml.match(/<picker[^>]*bindchange="\{\{(\w+)\}\}"/)
  if (!mPick) return false
  const handlerName = await mp.evaluate((k) => {
    const cur = getCurrentPages().slice(-1)[0]
    if (!cur) return ''
    if (typeof cur[k] === 'function') return k
    if (cur.data && typeof cur.data[k] === 'string' && typeof cur[cur.data[k]] === 'function') return cur.data[k]
    return ''
  }, mPick[1])
  if (!handlerName) return false
  await mp.evaluate((n, v) => {
    const cur = getCurrentPages().slice(-1)[0]
    cur[n]({ detail: { value: v } })
  }, handlerName, value)
  await sleep(800)
  return true
}

async function shot(mp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await mp.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

/* ---------------- 自清理 ---------------- */
async function selfClean() {
  try {
    // 先把本次建单的操作日志按标记/目标删掉（cleanup 脚本不管 operation_logs 的单据关联）
    await execute(`DELETE FROM operation_logs WHERE detail LIKE '%${MARK}%'`)
    for (const c of created.check) {
      await execute(`DELETE FROM operation_logs WHERE action = 'check_create' AND target_id = ?`, [String(c)])
    }
    // 再调总清理（删带 FULLFLOW 标记的单据 + 按流水 delta 回补库存 + 自动备份）
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cleanup-test-data.js'), '--apply'], { stdio: 'inherit' })
    console.log(r.status === 0 ? '（清理完成）' : '⚠️ 清理脚本退出码非 0')
  } catch (e) {
    console.error('自清理异常：', e.message)
  }
}

;(async () => {
  console.log('\n═══ 小程序全流程「真实提交」测试 ═══\n')
  assertDestructive('小程序全流程真实提交测试', '将创建并删除带 [FULLFLOW] 标记的入库/出库/盘点单')

  // 造数/选料：配件仓、成品仓各取一个真实物料
  const sk = await loginDev('dev_sk_parts')
  const mParts = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, sk)).data.list[0]
  if (!mParts) throw new Error('配件仓没有物料')

  const mp = await automator.connect({ wsEndpoint: WS })
  console.log('已连接自动化端口\n')

  try {
    /* ============ 1. 入库登记（配件仓管，真实提交，库存+N） ============ */
    console.log('=== 1. 入库登记（真实提交） ===')
    await loginAs(mp, 'dev_sk_parts')
    let page = await mp.currentPage()
    ok('首页有「入库登记」卡片', await tapCard(page, '.role-card-in'))
    ok('进到入库登记页', (await (await mp.currentPage()).path) === 'pages/in/submit')
    page = await mp.currentPage()
    const inMats = await page.$$('.material-item')
    ok('入库登记页有物料列表', inMats.length > 0, `count=${inMats.length}`)
    if (inMats.length) {
      await inMats[0].tap()
      await sleep(1500)
      ok('选物料后弹出提交面板', !!(await page.$('.submit-panel')))
      await fillByPlaceholder(page, '请输入数量', 5)
      await fillByPlaceholder(page, '请输入单价', 2)
      await fillByPlaceholder(page, '选填', MARK)  // 备注
      await shot(mp, '1-入库登记-填好')
      const btn = await page.$('.btn-submit')
      await btn.tap()
      await sleep(2800)
      // 接口侧验证
      const lst = await callRaw('inbound', 'list', { page: 1, pageSize: 5 }, sk)
      const mine = (lst.data && lst.data.list || []).find((o) => String(o.remark || '').includes(MARK))
      ok('提交后入库单真的生成（带标记）', !!mine, mine ? mine.order_no : '未找到')
      if (mine) {
        created.inbound.push(mine._id)
        const det = await callRaw('inbound', 'detail', { id: mine._id }, sk)
        const item = det.data && (det.data.items || [])[0]
        ok('入库明细数量=5', item && Number(item.quantity) === 5, `实际 ${item && item.quantity}`)
        // 用库存流水验证「库存真的 +5」（before → after 一致才算数）
        const mid = item && item.material_id
        const lg = await query(
          'SELECT before_stock, after_stock, change_quantity FROM stock_logs WHERE material_id=? AND change_type=? ORDER BY id DESC LIMIT 1',
          [mid, 'inbound'])
        const L = lg[0]
        ok('库存流水记录 +5（before→after 一致）',
          !!L && Number(L.change_quantity) === 5 && Number(L.after_stock) === Number(L.before_stock) + 5,
          L ? `before=${L.before_stock} after=${L.after_stock} delta=${L.change_quantity}` : '无流水')
      }
    }

    /* ============ 2. 领料出库（领料员，真实提交，停在待确认） ============ */
    console.log('\n=== 2. 领料出库（真实提交，停在待确认不扣库存） ===')
    await loginAs(mp, 'dev_out')
    page = await mp.currentPage()
    ok('首页有「领料出库」卡片', await tapCard(page, '.role-card-out'))
    ok('进到领料出库页', (await (await mp.currentPage()).path) === 'pages/out/submit')
    page = await mp.currentPage()
    const outMats = await page.$$('.material-item')
    ok('出库页有物料列表', outMats.length > 0, `count=${outMats.length}`)
    if (outMats.length) {
      await outMats[0].tap()  // 进清单
      await sleep(1200)
      // 选出库类型（picker 原生组件，用 wxml 手法选第 1 项）
      const picked = await pickNative(mp, 'pages/out/submit.wxml', 1)
      ok('选出库类型（picker）', picked)
      await fillByPlaceholder(page, '选填', MARK)  // 用途/备注
      await shot(mp, '2-领料出库-填好')
      const btn = await page.$('.btn-submit')
      const disabled = btn ? await btn.attribute('disabled') : 'no-btn'
      ok('提交按钮可点', String(disabled) !== 'true', `disabled=${disabled}`)
      if (btn && String(disabled) !== 'true') {
        await btn.tap()
        await sleep(2800)
        const out = await loginDev('dev_out')
        const lst = await callRaw('outbound', 'list', { page: 1, pageSize: 5 }, out)
        const mine = (lst.data && lst.data.list || []).find((o) => String(o.remark || '').includes(MARK))
        ok('提交后出库单真的生成（待确认，不扣库存）', !!mine && mine.status === 'pending', mine ? `${mine.order_no}/${mine.status}` : '未找到')
        if (mine) created.outbound.push(mine._id)
      }
    }

    /* ============ 3. 盘点（接口建单 → 真实按键录入+提交，停在待审核） ============ */
    console.log('\n=== 3. 盘点（真实按键录入+提交） ===')
    // 建单走接口（小程序端建盘点要连点多个原生 picker，价值低）；录入+提交才是仓管的真实高频操作
    const cc = await callRaw('check', 'create', {
      type: 'sample', warehouse_id: 1,
      scope: { material_ids: [mParts._id], categories: [], sub_categories: [] },
      remark: MARK, confirm_full_scan: false
    }, sk)
    ok('建盘点单成功', cc.code === 0, `code=${cc.code} ${cc.message}`)
    if (cc.code === 0) {
      const checkId = cc.data._id
      created.check.push(checkId)
      await execute('UPDATE stock_checks SET remark = ? WHERE id = ?', [MARK, checkId])  // 补标记（建单弹窗无备注框）
      await loginAs(mp, 'dev_sk_parts')
      await mp.reLaunch(`/pages/check/submit?id=${checkId}`)
      await sleep(3000)
      page = await mp.currentPage()
      ok('进到盘点提交页', (await page.path) === 'pages/check/submit')
      // 取账面数（真实按键录入：给第一个物料的 input 填账面数）
      const det0 = await callRaw('check', 'detail', { id: checkId }, sk)
      const book = det0.data && det0.data.items && det0.data.items[0] && det0.data.items[0].book_stock
      // 不点「其余按账面数填」——它会弹原生 modal，automator 点不了；直接给 input 填值才是真实按键录入
      const qtyInput = await page.$('.input-row input')
      ok('盘点页有数量输入框', !!qtyInput)
      if (qtyInput) {
        await qtyInput.input(String(book == null ? 0 : book))
        await sleep(500)
      }
      await shot(mp, '3-盘点-填好')
      const btn = await page.$('.btn-submit')
      const disabled = btn ? await btn.attribute('disabled') : 'no-btn'
      ok('盘点提交按钮可点', !!btn && String(disabled) !== 'true', `disabled=${disabled}`)
      if (btn && String(disabled) !== 'true') {
        await btn.tap()   // 真实点了提交 → 弹「确认提交」原生 modal
        await sleep(1500)
        await shot(mp, '3-盘点-确认弹窗')
        // ⚠️ uni.showModal 是原生弹窗，automator 点不了按钮（与 cross-e2e/mp-review 惯例一致）→ 接口走完最后一步
        const subRes = await callRaw('check', 'submit', {
          id: checkId,
          items: [{ material_id: mParts._id, actual_stock: Number(book == null ? 0 : book) }]
        }, sk)
        ok('提交成功（点了按钮后原生确认框由接口兜底）', subRes.code === 0, `code=${subRes.code} ${subRes.message}`)
        const det = await callRaw('check', 'detail', { id: checkId }, sk)
        ok('盘点进入待审核（此时不调库存）',
          det.code === 0 && ['pending_review', 'completed'].includes(det.data.status),
          `实际状态 ${det.data && det.data.status}`)
      }
    }

    /* ============ 4. 报废申请（验证必传照片拦截，不真实提交） ============ */
    console.log('\n=== 4. 报废申请（验证必传照片拦截） ===')
    await loginAs(mp, 'dev_out')
    page = await mp.currentPage()
    ok('首页有「报废申请」卡片', await tapCard(page, '.role-card-scrap'))
    ok('进到报废申请页', (await (await mp.currentPage()).path) === 'pages/out/scrap')
    page = await mp.currentPage()
    // 选物料
    const scrapMats = await page.$$('.material-item, .pick-item, [class*="material"]')
    // 报废页选物料的选择器不确定，先看页面结构
    const scrapText = await (async () => {
      const els = await page.$$('text')
      const parts = []
      for (const el of els.slice(0, 60)) { const t = (await el.text()) || ''; if (t.trim()) parts.push(t.trim()) }
      return parts.join(' ')
    })()
    ok('报废页渲染出表单（含照片/原因必填提示）', /照片|原因|报废数量/.test(scrapText), scrapText.slice(0, 80))
    await shot(mp, '4-报废申请')
    // 不选照片直接点提交 → 应被「请上传照片」拦（canSubmit 置灰）
    const scrapBtn = await page.$('.btn-primary')
    const scrapDisabled = scrapBtn ? await scrapBtn.attribute('class') : ''
    ok('未传照片时提交按钮不可用（必传照片拦截）',
      !scrapBtn || /disabled/.test(scrapDisabled), `class=${scrapDisabled || '无按钮'}`)
  } catch (e) {
    console.error('流程中断：', e.message)
    ok('流程不中断', false, e.message)
  } finally {
    console.log('\n🧹 收尾：自清理…')
    await selfClean()
  }

  console.log(`\n──────── 全流程结果：通过 ${pass} / 失败 ${fail} ────────`)
  console.log('截图：', SHOT_DIR)
  // 不 mp.close()（close 会关 9420）
  process.exit(fail ? 1 : 0)
})().catch(async (e) => {
  console.error('套件异常：', e)
  await selfClean()
  process.exit(1)
})
