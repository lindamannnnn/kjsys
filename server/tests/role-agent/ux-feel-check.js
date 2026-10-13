/**
 * ============================================================
 * 体感复验（真实浏览器）—— 专测「点了有没有真反应」
 * ------------------------------------------------------------
 * 和 ui-check 的区别：
 *   ui-check 查「页面能不能渲染出来」（白屏 / 报错 / 数字对不对）
 *   本脚本 查「你点了以后到底发生了什么」—— 请求有没有发、带没带对参数、
 *   防抖生效没有、上拉能不能真加载、按钮是不是真能按。
 *   这些才是「用起来顺不顺」的硬证据。
 *
 * 用法（⚠️ H5 静态服务必须与本脚本在同一条 Bash 命令里起，否则命令结束进程被回收）：
 *   cd server
 *   node tests/role-agent/static-serve.js ../miniprogram/dist/build/h5 5174 & sleep 2
 *   node tests/role-agent/ux-feel-check.js
 *
 * 输出：tests/role-agent/results/UX-feel-report-<时间戳>.md
 *
 * ⚠️ 口径：跑的是 H5 产物，只作**交互逻辑**证据；小程序真机体感（手感 / 滚动流畅）
 *    需在微信开发者工具或真机补验，本报告不臆断。
 * ============================================================
 */
require('../../src/config/env')
const fs = require('fs')
const path = require('path')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { loginDev, callRaw } = require('./lib')
const { query, execute, pool } = require('../../src/db/pool')

const H5_URL = process.env.H5_URL || 'http://127.0.0.1:5174'
const OUT_DIR = path.join(__dirname, 'results')
const MARK = '[UX-FEEL]'

const results = []
function check(section, label, cond, level = 'P1', detail = '') {
  results.push({ section, label, pass: !!cond, level: cond ? '' : level, detail: String(detail || '') })
  console.log(cond ? `  ✅ ${label}` : `  ❌ ${label} ${detail}`)
  return !!cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 记录页面发出的所有 /api/ 请求（含 action 与 data） */
function watchRequests(page, bucket) {
  page.on('request', (req) => {
    const u = req.url()
    if (!/\/api\//.test(u)) return
    let action = '', data = null
    try {
      const pd = req.postData()
      if (pd) { const b = JSON.parse(pd); action = b.action || ''; data = b.data || null }
    } catch (e) { /* ignore */ }
    bucket.push({ mod: (u.match(/\/api\/([^/?]+)/) || [])[1] || '', action, data })
  })
}

/** 以某个开发身份进 H5 */
async function openAs(browser, openid, hash) {
  const page = await browser.newPage()
  await page.addInitScript((id) => {
    try { localStorage.setItem('sl_dev_openid', id); localStorage.removeItem('sl_token') } catch (e) {}
  }, openid)
  await page.goto(`${H5_URL}/#${hash}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  return page
}

/**
 * 点元素。sel 可以是：
 *   'text=通知采购' —— 子串匹配（会命中「通知采购」这个按钮）
 *   'text="通知"'   —— 精确匹配（**不会**命中「通知采购」，专门点确认弹窗的按钮）
 *   '.uni-modal__btn:last-child' —— CSS 兜底
 *
 * ⚠️ 踩过的坑：确认弹窗的按钮叫「通知」，而触发它的按钮叫「通知采购」。
 *    用子串匹配 text=通知 会先命中「通知采购」→ 又点一遍触发按钮 → 弹窗永远不关、接口永不发。
 */
async function clickSel(page, sel, timeout = 4000) {
  try {
    const el = page.locator(sel).first()
    await el.waitFor({ state: 'visible', timeout })
    await el.click({ timeout })
    return true
  } catch (e) { return false }
}

async function pageText(page) {
  return await page.evaluate(() => document.body.innerText || '')
}

// ---------------------------------------------------------------
// 1. 看板日期切换：点了是不是真重新取数（2026-10-09 修的核心是这条）
// ---------------------------------------------------------------
async function checkDashboard(browser) {
  console.log('\n=== 1. 看板「今天/本周/本月」切换 ===')
  const page = await openAs(browser, 'dev_boss', '/pages/boss/dashboard')
  const reqs = []
  watchRequests(page, reqs)

  const text0 = await pageText(page)
  check('看板', '看板渲染出日期 tab', /今天/.test(text0) && /本周/.test(text0) && /本月/.test(text0), 'P1', text0.slice(0, 100))

  for (const [label, period] of [['本周', 'week'], ['本月', 'month'], ['今天', 'today']]) {
    reqs.length = 0
    const ok = await clickSel(page, `text=${label}`)
    await sleep(1600)
    const r = reqs.filter((x) => x.mod === 'stats' && x.action === 'overview')
    check('看板', `点「${label}」真的重新发了请求`, ok && r.length >= 1, 'P0', `点击=${ok} 请求数=${r.length}`)
    check('看板', `「${label}」请求带 period=${period}`, r.length > 0 && r[0].data && r[0].data.period === period, 'P0',
      r.length ? JSON.stringify(r[0].data) : '无请求')
    const t = await pageText(page)
    check('看板', `切到「${label}」后 KPI 标题跟着变`, t.includes(`${label}出库单数`), 'P1',
      (t.match(/.*出库单数.*/) || ['(没找到)'])[0])
  }
  await page.close()
}

// ---------------------------------------------------------------
// 2. 预警页「通知采购」：不再是假按钮（原 P0）
// ---------------------------------------------------------------
async function checkWarning(browser) {
  console.log('\n=== 2. 预警页「通知采购」 ===')
  const m = await query('SELECT id, name, current_stock, warning_stock, warehouse_id FROM materials WHERE warehouse_id = 1 ORDER BY id LIMIT 1')
  if (!m.length) { check('预警', '找到用于造预警的物料', false, 'P1', '无物料'); return }
  const mat = m[0]
  const origStock = Number(mat.current_stock)
  const origWarn = Number(mat.warning_stock)

  try {
    // ⚠️ 造数据的 SQL **必须写在 try 里面**：一旦中间那句崩了，finally 才会执行还原。
    //    曾把 UPDATE 写在 try 之前 → 脚本崩在下一句 INSERT（字段名写错）→ finally 没跑
    //    → 物料被永久改成库存 0 / 预警值 5，污染了基线，还得翻备份表找回原值。
    await execute('UPDATE materials SET current_stock = 0, warning_stock = 5 WHERE id = ?', [mat.id])
    // 预警口径要求 EXISTS(stock_logs)，所以流水不能少
    // ⚠️ 字段是 change_type / change_quantity（不是 type / change_qty）
    await execute(
      `INSERT INTO stock_logs (material_id, material_name, warehouse_id, change_type, change_quantity,
        before_stock, after_stock, operator_openid, operator_name, remark, created_at)
       VALUES (?, ?, ?, 'adjust', ?, ?, 0, 'dev_ux_feel', '体感复验', ?, NOW())`,
      [mat.id, mat.name, mat.warehouse_id, -origStock, origStock, `${MARK} 体感复验临时预警`]
    )

    const page = await openAs(browser, 'dev_boss', '/pages/boss/warning')
    const reqs = []
    watchRequests(page, reqs)
    const text0 = await pageText(page)
    check('预警', '预警页列出了刚造的预警物料', /通知采购/.test(text0) && /已缺货|库存不足|低于/.test(text0), 'P1',
      text0.slice(0, 150).replace(/\n/g, ' '))

    reqs.length = 0
    const clicked = await clickSel(page, 'text=通知采购')
    await sleep(900)
    // 二次确认弹窗（uni.showModal 在 H5 渲染成 DOM）：按「精确文本 → CSS 兜底」逐个试
    const confirmSels = ['text="确定"', 'text="确认"', 'text="通知"', '.uni-modal__btn:last-child']
    let confirmed = false
    for (const s of confirmSels) { if (await clickSel(page, s, 1500)) { confirmed = true; break } }

    // ⚠️ 采样必须「边等边采」：toast 默认只显示 1.5s，
    //    如果先 sleep(2000) 等请求再采，toast 早消失了 —— 会误判成「点了没反馈」。
    let toast = ''
    for (let i = 0; i < 20; i++) {
      const t = await pageText(page)
      const hit = t.match(/已通知[^。\n]{0,40}|通知成功[^。\n]{0,20}|没有可通知[^。\n]{0,20}|通知失败[^。\n]{0,30}/)
      if (hit) { toast = hit[0]; break }
      await sleep(300)
    }

    const notify = reqs.filter((r) => r.mod === 'stats' && r.action === 'notifyWarning')
    check('预警', '点「通知采购」真的调了 notifyWarning 接口', notify.length >= 1, 'P0',
      `触发点击=${clicked} 确认点击=${confirmed} 请求数=${notify.length}`)
    if (notify.length) {
      check('预警', '通知带上物料标识（不是整批乱发）', notify[0].data && notify[0].data.material_id != null, 'P1',
        JSON.stringify(notify[0].data))
    }
    check('预警', '通知后页面给了可见反馈（toast，不是静默）', !!toast, 'P1',
      toast || '20 次采样（约 6 秒）都没抓到提示文案 —— 等于用户点了不知道有没有成功')
    await page.close()
  } finally {
    await execute('DELETE FROM stock_logs WHERE remark = ?', [`${MARK} 体感复验临时预警`])
    // ⚠️ current_stock 和 warning_stock **都要**还原（只还原库存会留下被改过的预警值）
    await execute('UPDATE materials SET current_stock = ?, warning_stock = ? WHERE id = ?', [origStock, origWarn, mat.id])
    await execute("DELETE FROM messages WHERE type = 'warning_notify'")
    console.log(`  已还原：物料 #${mat.id} 库存=${origStock} 预警值=${origWarn}、临时流水与通知消息`)
  }
}

// ---------------------------------------------------------------
// 3. 搜索防抖：连敲 6 个字，请求次数必须远小于 6
// ---------------------------------------------------------------
async function checkDebounce(browser) {
  console.log('\n=== 3. 搜索防抖（连敲 6 个字） ===')
  const page = await openAs(browser, 'dev_out', '/pages/out/submit')
  const reqs = []
  watchRequests(page, reqs)

  const box = page.locator('input').first()
  try {
    await box.waitFor({ state: 'visible', timeout: 5000 })
  } catch (e) {
    check('搜索', '找到搜索输入框', false, 'P1', String(e).slice(0, 120))
    await page.close(); return
  }
  reqs.length = 0
  await box.click()
  for (const ch of ['A', 'A', '0', '0', '1', '-']) {
    await page.keyboard.type(ch, { delay: 0 })
    await sleep(60)
  }
  await sleep(2000)
  const list = reqs.filter((r) => r.mod === 'material' && r.action === 'list')
  check('搜索', '连敲 6 个字请求次数 <= 3（防抖生效）', list.length <= 3, 'P0', `实际发了 ${list.length} 次`)
  check('搜索', '确实发起了搜索（不是没反应）', list.length >= 1, 'P1', `实际 ${list.length} 次`)
  await page.close()
}

// ---------------------------------------------------------------
// 4. 上拉加载：造够数据，滚到底，看是不是真的加载第二页
// ---------------------------------------------------------------
async function checkLoadMore(browser) {
  console.log('\n=== 4. 上拉加载（造 25 条任务，滚到底看会不会加载第二页） ===')
  const sk = await loginDev('dev_sk')
  const mat = await query('SELECT id FROM materials WHERE warehouse_id = 1 ORDER BY id LIMIT 1')
  const mid = mat.length ? mat[0].id : 1
  const ids = []
  let created = 0
  for (let i = 0; i < 25; i++) {
    const r = await callRaw('purchase', 'create', {
      warehouse_id: 1, assignee_openid: 'dev_purchase',
      remark: `${MARK}上拉测试#${i}`, items: [{ material_id: mid, quantity: 1 }]
    }, sk)
    if (r && r.code === 0 && r.data && r.data._id) { ids.push(r.data._id); created++ }
  }
  check('上拉', `造出足够的任务（${created}/25）`, created >= 20, 'P1', `实际 ${created}`)

  try {
    const page = await openAs(browser, 'dev_purchase', '/pages/purchase/tasks')
    const reqs = []
    watchRequests(page, reqs)
    await sleep(1200)
    reqs.length = 0

    // 滚到底：先滚页面，再滚内部所有可滚元素
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
      const all = Array.from(document.querySelectorAll('*'))
      for (const e of all) {
        if (e.scrollHeight > e.clientHeight + 10) { try { e.scrollTop = e.scrollHeight } catch (_) {} }
      }
    })
    await sleep(2200)
    const lists = reqs.filter((r) => r.mod === 'purchase' && r.action === 'list')
    const p2 = lists.filter((r) => r.data && Number(r.data.page) === 2)
    check('上拉', '滚到底真的加载了第二页（page=2）', p2.length >= 1, 'P0',
      `list 请求 ${lists.length} 次，其中 page=2 的 ${p2.length} 次；page 序列=${lists.map((r) => r.data && r.data.page).join(',')}`)
    // ⚠️ 判据别用 remark：任务列表卡片显示的是**任务号/物料/状态**，不显示 remark。
    //    认任务号 CG- + 状态文案，才是列表上真实可见的东西。
    const t = await pageText(page)
    check('上拉', '页面渲染出任务行（任务号 + 状态）', /CG-\d{8}-\d{3}/.test(t) && /待领取|采购中|待收料|已入库/.test(t), 'P1',
      t.slice(0, 160).replace(/\n/g, ' '))
    await page.close()
  } finally {
    for (const id of ids) {
      await execute('DELETE FROM purchase_task_items WHERE task_id = ?', [id]).catch(() => {})
      await execute('DELETE FROM purchase_tasks WHERE id = ?', [id]).catch(() => {})
    }
    // ⚠️ 建任务会给采购员发站内消息，消息正文里**没有**任务 remark，
    //    光按内容 LIKE 标记删不干净（实测漏了 75 条）→ 按 ref_id 关联删（ref_id 是 varchar，传字符串）
    if (ids.length) {
      const ph = ids.map(() => '?').join(',')
      const strIds = ids.map(String)
      await execute(
        `DELETE FROM messages WHERE ref_id IN (${ph}) OR (type = 'purchase_task_assigned' AND to_openid = 'dev_purchase')`,
        strIds
      ).catch(() => {})
    }
    await execute('DELETE FROM messages WHERE content LIKE ? OR title LIKE ?', [`%${MARK}%`, `%${MARK}%`]).catch(() => {})
    console.log(`  已还原：删掉 ${ids.length} 条探针任务及其消息`)
  }
}

// ---------------------------------------------------------------
// 5. 关键入口是否真的可见（修过的功能不能被藏起来）
// ---------------------------------------------------------------
async function checkEntries(browser) {
  console.log('\n=== 5. 新加入口是否真的可见 ===')

  // 「我的」页 —— 修改密码（原 P0：强制改密门禁没有页面，命中即锁死）
  {
    const page = await openAs(browser, 'dev_out', '/pages/my/profile')
    const t = await pageText(page)
    check('入口', '「我的」页有「修改密码」入口', /修改密码/.test(t), 'P0', t.slice(0, 200).replace(/\n/g, ' '))
    const ok = await clickSel(page, 'text=修改密码')
    check('入口', '「修改密码」点得进去（不是死链）', ok, 'P0', '点了没跳')
    await sleep(1200)
    const t2 = await pageText(page)
    check('入口', '改密页渲染出表单', /新密码|确认|原密码/.test(t2), 'P1', t2.slice(0, 160).replace(/\n/g, ' '))
    await page.close()
  }

  // 出库历史 —— 空态也要能渲染（库里现在 0 张单，是合法空态，不能误判成坏了）
  {
    const page = await openAs(browser, 'dev_out', '/pages/out/history')
    const t = await pageText(page)
    check('入口', '出库历史页渲染（空态也算）', t.length > 10 && /出库|历史|暂无|没有/.test(t), 'P1', t.slice(0, 120).replace(/\n/g, ' '))
    await page.close()
  }
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------
async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    await checkDashboard(browser)
    await checkWarning(browser)
    await checkDebounce(browser)
    await checkLoadMore(browser)
    await checkEntries(browser)
  } finally {
    await browser.close()
  }

  const pass = results.filter((r) => r.pass).length
  const fail = results.length - pass
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const md = [
    '# 体感复验报告（真实浏览器 · 点了有没有真反应）',
    '',
    `- 时间：${new Date().toLocaleString('zh-CN')}`,
    `- 断言 ${results.length} 条，通过 ${pass}，失败 ${fail}`,
    `- 结论：${fail === 0 ? '**全部有反应**' : '**有按钮点了没反应**'}`,
    '',
    '| 分组 | 检查项 | 结果 | 证据 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.section} | ${r.label} | ${r.pass ? '✅' : `❌ ${r.level}`} | ${(r.detail || '').replace(/\|/g, '/').slice(0, 160)} |`),
    '',
    '> ⚠️ 口径：跑的是 H5 产物，只作**交互逻辑**证据；小程序真机体感（手感 / 滚动流畅度）需',
    '> 在微信开发者工具或真机补验。'
  ].join('\n')
  const mdPath = path.join(OUT_DIR, `UX-feel-report-${ts}.md`)
  fs.writeFileSync(mdPath, md, 'utf8')
  console.log(`\n结果：${pass} 过 / ${fail} 挂`)
  console.log(`📄 报告：${mdPath}`)
  await pool.end()
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => { console.error('崩溃：', e); try { await pool.end() } catch (_) {} process.exit(2) })
