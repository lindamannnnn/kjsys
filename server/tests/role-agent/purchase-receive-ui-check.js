/**
 * ============================================================
 * 采购「到货入库」页面层验证（真实浏览器跑道）
 * ------------------------------------------------------------
 * 为什么单独有这一个：接口层已经被 purchase-peritem-check.js 覆盖 36 项，
 * 但**接口对不代表页面能用** —— 按钮文案、旧按钮是否真的删掉、
 * 点一下到不到得了后端、库存标签会不会跟着变，只有真点一遍才知道。
 *
 * 验收口径（对应 2026-10-09「到货即入库」改版）：
 *   ① 页面上是「到货入库」按钮，且**已经没有**单独的「入库」按钮（.recv-btn.stock 计数为 0）
 *   ② 到货区有「点『到货入库』就实时写库存」的说明条
 *   ③ 填数量点一下 + 确认 → 真发 purchase.receiveItem，库存真加上
 *   ④ 页面出现该明细的入库单标签（recv-order-tag）
 *   ⑤ 分次到货只加差额（第二次补到 5 只 +2）
 *   ⑥ 「完成收货」可点、办结后库存不再变化
 *
 * 用法（⚠️ H5 静态服务必须与本脚本在同一条 Bash 命令里起，否则命令结束进程被回收）：
 *   cd server
 *   node tests/role-agent/static-serve.js ../miniprogram/dist/build/h5 5174 & sleep 2
 *   node tests/role-agent/purchase-receive-ui-check.js
 *   kill %1
 *
 * ⚠️ 口径说明：跑的是 **H5 产物**，只能作「交互逻辑 / 文案」证据，
 *    不能当小程序已验收（小程序以 mp-weixin 包 + 开发者工具为准）。
 * ============================================================
 */
require('../../src/config/env')
const path = require('path')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { loginDev, callRaw } = require('./lib')
const { query, queryOne } = require('../../src/db/pool')
const { autoCleanup } = require('./_cleanup')

const H5_URL = process.env.H5_URL || 'http://127.0.0.1:5174'
const MARK = '[V5-UIRECV]'

let pass = 0, fail = 0
// ⚠️ 参数顺序踩过坑：写成 check(label, cond) 而调用是 (section, label, cond, level, detail)
//    → 标签字符串被当成 cond（恒真）→ 23 项**全部空过**却显示全绿。
//    改判据/改签名后必须回跑一次，确认它真会挂（对照实验铁律）。
function check(section, label, cond, level = 'P1', detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const stockOf = async (id) => Number((await queryOne('SELECT current_stock FROM materials WHERE id = ?', [id])).current_stock)

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

async function openAs(browser, openid, hash) {
  const page = await browser.newPage()
  await page.addInitScript((id) => {
    try { localStorage.setItem('sl_dev_openid', id); localStorage.removeItem('sl_token') } catch (e) {}
  }, openid)
  await page.goto(`${H5_URL}/#${hash}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  return page
}

const pageText = (page) => page.evaluate(() => document.body.innerText || '')

/** 往第 idx 个到货数量输入框填值（uni H5 里 class 落在外层 uni-input 上，内层才是真 input） */
async function fillRecvQty(page, idx, val) {
  const sels = ['.recv-input input', '.recv-input .uni-input-input', '.recv-input']
  for (const s of sels) {
    const loc = page.locator(s).nth(idx)
    try {
      if (await loc.count() === 0) continue
      await loc.fill(String(val), { timeout: 3000 })
      return true
    } catch (e) { /* 试下一个 */ }
  }
  return false
}

/** 点弹窗的「确认」：精确匹配，避免命中页面上的触发按钮 */
async function clickConfirm(page) {
  const tries = ['text="确认"', '.uni-modal__btn:last-child', '.uni-modal__btn_primary']
  for (const s of tries) {
    try {
      const el = page.locator(s).first()
      await el.waitFor({ state: 'visible', timeout: 2500 })
      await el.click({ timeout: 2500 })
      return true
    } catch (e) { /* 试下一个 */ }
  }
  return false
}

/**
 * 依次尝试多个选择器点下去，第一个成功的为准。
 *
 * ⚠️ 血泪教训：本页**不能**用 `text=到货入库` 点按钮 —— 页面上的说明条
 *    「点『到货入库』就实时写库存」也含这四个字，`text=` 是子串匹配，
 *    而且 `.first()` 会命中排在 DOM 更前面的说明文案 → 点了没反应、
 *    接口一次都不发，但脚本「点击成功」返回 true，看着像过了。
 *    「完成收货」同理（说明条里写着「再点最下方『完成收货』办结」）。
 *    所以一律用 CSS 精确落到按钮上，精确文案只作兜底。
 */
async function clickAny(page, sels, timeout = 4000) {
  for (const s of sels) {
    try {
      const el = page.locator(s).first()
      if (await el.count() === 0) continue
      await el.waitFor({ state: 'visible', timeout })
      await el.click({ timeout })
      return s
    } catch (e) { /* 试下一个 */ }
  }
  return ''
}

/** toast 只显示约 1.5s —— 必须「边等边采」，先 sleep 再抓会采空（踩过） */
async function grabToast(page, ms = 1600) {
  let last = ''
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const t = await page.evaluate(() => {
        const el = document.querySelector('.uni-toast, .uni-sample-toast')
        return el ? (el.innerText || '') : ''
      })
      if (t) last = t
    } catch (e) { /* ignore */ }
    await sleep(120)
  }
  return last
}

async function main() {
  const sk = await loginDev('dev_sk_parts')
  const pc = await loginDev('dev_purchase')

  // ---------- 造数：测试物料 + 采购任务（走到「已提交采购信息」待收料） ----------
  const findMat = async (name) => {
    const r = await callRaw('material', 'list', { warehouse_id: 1, keyword: name, page: 1, pageSize: 5 }, sk)
    return ((r.data && r.data.list) || []).find((m) => m.name === name)
  }
  let m = await callRaw('material', 'upsert', {
    name: `${MARK}料`, spec: 'UI-1', category: '测试类', unit: '个', warehouse_id: 1, remark: MARK
  }, sk)
  if (m.code === 409) m = { code: 0, data: { _id: (await findMat(`${MARK}料`))._id } }
  if (m.code !== 0) { console.log('造物料失败：', JSON.stringify(m)); process.exit(1) }
  const mid = m.data._id
  const base = await stockOf(mid)

  // 先入 10 件 @10，让物料有库存与均价基数
  const ib = await callRaw('inbound', 'submit', {
    warehouse_id: 1, supplier: 'V5-UI供应商', remark: MARK, items: [{ material_id: mid, quantity: 10, unit_price: 10 }]
  }, sk)
  if (ib.code !== 0) { console.log('入库失败：', JSON.stringify(ib)); process.exit(1) }
  await callRaw('inbound', 'confirm', { id: ib.data._id }, sk)
  const baseAfterInbound = await stockOf(mid)

  const c = await callRaw('purchase', 'create', {
    warehouse_id: 1, assignee_openid: 'dev_purchase', remark: MARK,
    items: [{ material_id: mid, quantity: 5 }]
  }, sk)
  if (c.code !== 0) { console.log('建任务失败：', JSON.stringify(c)); process.exit(1) }
  const tid = c.data._id
  await callRaw('purchase', 'take', { id: tid }, pc)
  const en = await callRaw('purchase', 'entry', {
    id: tid, items: [{ material_id: mid, unit_price: 12, purchase_channel: '淘宝', external_no: 'TB-UI-1' }]
  }, pc)
  if (en.code !== 0) { console.log('采购录入失败：', JSON.stringify(en)); process.exit(1) }

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    // ------------------------------------------------ ① 页面结构
    console.log('\n=== ① 页面结构：按钮与说明条 ===')
    const page = await openAs(browser, 'dev_sk_parts', `/pages/purchase/task-detail?id=${tid}`)
    const reqs = []
    watchRequests(page, reqs)
    await sleep(800)

    let t = await pageText(page)
    check('结构', '详情页渲染出任务号与采购明细', /CG-\d{8}-\d{3}/.test(t) && t.includes('采购明细'), 'P1', t.slice(0, 120).replace(/\n/g, ' '))
    check('结构', '出现「到货入库」按钮', t.includes('到货入库'), 'P0',
      (t.match(/.*(到货|入库).*/) || ['(没找到)'])[0])

    const oldStockBtns = await page.locator('.recv-btn.stock').count()
    check('结构', '★ 旧「入库」按钮已不存在（.recv-btn.stock 计数 0）', oldStockBtns === 0, 'P0', `实际 ${oldStockBtns} 个`)
    check('结构', '有「点『到货入库』就实时写库存」说明条', t.includes('实时写库存'), 'P1', t.slice(0, 200).replace(/\n/g, ' '))

    // ------------------------------------------------ ② 点到货入库 → 真加库存
    console.log('\n=== ② 点「到货入库」：真发请求 + 真加库存 ===')
    const filled = await fillRecvQty(page, 0, 3)
    check('到货', '能填到货数量', filled, 'P0', '找不到输入框')
    reqs.length = 0
    const clickedSel = await clickAny(page, ['.recv-btn.ok', 'text="到货入库"'])
    check('到货', '「到货入库」按钮点得动', !!clickedSel, 'P0', '点了没反应')
    await sleep(700)
    const modalText = await pageText(page)
    check('到货', '弹出确认框且写明库存怎么变', /库存将增加 3/.test(modalText), 'P1',
      `点击落点=${clickedSel}；页面尾部=${modalText.slice(-160).replace(/\n/g, ' ')}`)
    const confirmed = await clickConfirm(page)
    const toast = await grabToast(page, 2000)
    check('到货', '确认弹窗点得掉', confirmed, 'P0', '弹窗没关')
    check('到货', 'toast 反馈里带「已入库 3」', /已入库 3/.test(toast), 'P1',
      `toast=${toast}（⚠️ callCloud 不返回 body.message，前端只能按差额自己拼提示）`)

    const recvReqs = reqs.filter((r) => r.mod === 'purchase' && r.action === 'receiveItem')
    check('到货', '★ 真发了 purchase.receiveItem', recvReqs.length >= 1, 'P0', `实际 ${recvReqs.length} 次`)
    check('到货', '★ 请求带的是 action=receive 且 received_qty=3',
      recvReqs.length > 0 && recvReqs[0].data && recvReqs[0].data.action === 'receive' && Number(recvReqs[0].data.received_qty) === 3,
      'P0', recvReqs.length ? JSON.stringify(recvReqs[0].data) : '无请求')
    check('到货', '★ 库存真的 +3（不用再点一次入库）', await stockOf(mid) === baseAfterInbound + 3,
      `${await stockOf(mid)} vs ${baseAfterInbound + 3}`)

    await sleep(1500)
    t = await pageText(page)
    check('到货', '标签显示实到/已入库数量', /实到 3\/5/.test(t) && /已入库 3/.test(t), 'P1', t.slice(0, 240).replace(/\n/g, ' '))
    const orderTags = await page.locator('.recv-order-tag').count()
    check('到货', '★ 页面出现该明细的入库单标签', orderTags >= 1, 'P0', `实际 ${orderTags} 个`)
    const orderText = orderTags ? await page.locator('.recv-order-tag').first().innerText() : ''
    check('到货', '入库单标签是真实单号 + 入库数量', /入库 3/.test(orderText), 'P1', `标签=「${orderText}」`)

    const dbOrders = await query(
      'SELECT order_no, status FROM inbound_orders WHERE source_item_id = ? ORDER BY id', [await sourceItemId(tid, mid)]
    )
    check('到货', '库里有 1 张 confirmed 入库单挂在该明细上',
      dbOrders.length === 1 && dbOrders[0].status === 'confirmed', 'P1', JSON.stringify(dbOrders))

    // ------------------------------------------------ ③ 改大 → 只补差额
    console.log('\n=== ③ 分次到货只补差额 ===')
    await fillRecvQty(page, 0, 5)
    reqs.length = 0
    await clickAny(page, ['.recv-btn.ok', 'text="到货入库"'])
    await sleep(700)
    await clickConfirm(page)
    const toast2 = await grabToast(page, 2000)
    check('分次', '★ 第二次到货只加差额 +2（不是再加 5）', /已入库 2/.test(toast2), 'P1', `toast=${toast2}`)
    check('分次', '★ 库存变成 +5（3+2）', await stockOf(mid) === baseAfterInbound + 5,
      `${await stockOf(mid)} vs ${baseAfterInbound + 5}`)

    // ------------------------------------------------ ④ 完成收货：可点且不再动库存
    console.log('\n=== ④ 「完成收货」办结：不再改库存 ===')
    await sleep(1500)
    t = await pageText(page)
    check('办结', '按钮文案是「完成收货」（不再是「完成入库」）',
      t.includes('完成收货') && !t.includes('完成入库'), 'P0',
      (t.match(/.*完成收货.*/) || ['(没找到)'])[0])
    const stockBefore = await stockOf(mid)
    // 「完成收货」也**必须**用 CSS 落点：说明条里就写着「再点最下方『完成收货』办结」
    const finSel = await clickAny(page, ['.action-bar .btn-primary', 'text="完成收货"'])
    check('办结', '「完成收货」点得动', !!finSel, 'P0', '点了没反应')
    await sleep(700)
    const finOk = await clickConfirm(page)
    check('办结', '办结确认弹窗点得掉', finOk, 'P0', `点击落点=${finSel}，弹窗没关`)
    await grabToast(page, 1500)
    await sleep(1800)
    check('办结', '★ 办结后库存不再变化（库存已在到货时加过）',
      await stockOf(mid) === stockBefore, `${await stockOf(mid)} vs ${stockBefore}`)
    const taskRow = await queryOne('SELECT status FROM purchase_tasks WHERE id = ?', [tid])
    check('办结', '任务状态变成 received', taskRow && taskRow.status === 'received', 'P1', JSON.stringify(taskRow))

    await page.close()
  } finally {
    await browser.close().catch(() => {})
  }
}

/** 取该任务里某物料的明细 id（source_item_id 用的是明细主键） */
async function sourceItemId(taskId, materialId) {
  const r = await queryOne(
    'SELECT id FROM purchase_task_items WHERE task_id = ? AND material_id = ? LIMIT 1', [taskId, materialId])
  return r ? r.id : 0
}

main()
  .then(() => {
    console.log(`\n结果：${pass} 过 / ${fail} 挂`)
    autoCleanup()
    process.exit(fail ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('\n脚本异常：', e && e.message ? e.message : e)
    autoCleanup()
    process.exit(1)
  })
