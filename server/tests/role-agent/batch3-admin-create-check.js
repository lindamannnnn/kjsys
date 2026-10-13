/**
 * ============================================================
 * 第三批 · 后台「新建单据」验收（仓管入库登记 + 厂长成品仓出库）
 * ------------------------------------------------------------
 * 背景：小程序上仓管有「入库登记」、厂长有「成品仓出库」，后台原来只有单据列表、
 *   不能开新单。本批新增 admin 端 /order/inbound-create 与 /order/outbound-create 两页。
 *
 * 验收口径：
 *   A. 接口层（后台与小程序共用同一套后端 action，直接验证权限与库存）：
 *      1. 仓管建入库单（自己仓）→ 成功、库存增加、单 pending、不填供应商 type=other
 *      2. 仓管跨仓建入库单 → 403
 *      3. 仓管填供应商 → type=purchase
 *      4. 仓管新增物料（upsert 自己仓）→ 成功；跨仓建档 → 403
 *      5. 厂长建成品仓出库（销售）→ 成功、提交即扣库存
 *      6. 厂长建配件仓出库 → 403 且提示语点名成品仓
 *      7. admin 建配件仓出库（维修）→ 成功
 *      8. 领料员建入库单 → 403（inbound.submit 不放行 out）
 *   B. 页面层（真实浏览器 + 真实后台账号 peijian/changzhang）：
 *      - 仓管菜单有「新建入库单」无「成品仓出库」；进新建页只能选配件仓
 *      - 厂长菜单有「成品仓出库」无「新建入库单」；页面锁成品仓、类型只有销售/领用
 *      - 厂长在后台真实开一张成品仓出库单 → 列表能查到（remark 带标记，收尾清掉）
 *
 * 用法（页面层需要静态服务，同一条命令里起）：
 *   cd server
 *   node tests/role-agent/static-serve.js ../admin/dist-local 5178 admin & sleep 2; \
 *     node tests/role-agent/batch3-admin-create-check.js; kill %1
 *
 * ⚠️ 会往真实库写数据（带 [RA-BK3] 标记 / dev_* 经手），跑完 autoCleanup() 清掉。
 * ============================================================
 */
require('../../src/config/env')

const path = require('path')
const fs = require('fs')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { callRaw, loginDev, loginAdmin } = require('./lib')
const { queryOne } = require('../../src/db/pool')
const { autoCleanup } = require('./_cleanup')

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:5178/admin'
const MARK = '[RA-BK3]'

let pass = 0
const failures = []
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else {
    failures.push({ label, detail })
    console.log(`  ❌ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const brief = (r) => `${r.code}: ${String(r.message || '').slice(0, 80)}`

/* ==================== A. 接口层 ==================== */

async function apiLayer() {
  console.log('\n===== A. 接口层（权限 + 库存） =====')
  const skParts = await loginDev('dev_sk_parts')   // 配件仓管
  const director = await loginDev('dev_director')  // 厂长
  const admin = await loginAdmin('admin', '123456')
  const outUser = await loginDev('dev_out')        // 领料员

  // 取两个仓各一个真实物料
  const m1 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, skParts)).data.list[0]
  const m2 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 2 }, director)).data.list[0]
  if (!m1 || !m2) throw new Error('两个仓都要有物料才能跑')
  const stockOf = async (id) =>
    Number((await queryOne('SELECT current_stock FROM materials WHERE id = ?', [id])).current_stock)

  // ---- 1. 仓管建入库单（自己仓，不填供应商 → type=other）
  {
    const before = await stockOf(m1._id)
    const r = await callRaw('inbound', 'submit', {
      warehouse_id: 1,
      items: [{ material_id: m1._id, quantity: 2, unit_price: 1.5 }],
      supplier: '', type: 'other', remark: `${MARK} 仓管自建入库`
    }, skParts)
    ok('A1 仓管建入库单（自己仓）成功', r.code === 0, brief(r))
    const after = await stockOf(m1._id)
    ok('A1 提交后库存 +2（提交即入账）', after === before + 2, `${before} → ${after}`)
    const detail = await callRaw('inbound', 'detail', { id: r.data && r.data._id }, skParts)
    ok('A1 单据 pending 等确认、类型 other',
      detail.data && detail.data.status === 'pending' && detail.data.type === 'other',
      `status=${detail.data && detail.data.status} type=${detail.data && detail.data.type}`)
  }

  // ---- 2. 仓管跨仓建入库单 → 403
  {
    const r = await callRaw('inbound', 'submit', {
      warehouse_id: 2,
      items: [{ material_id: m2._id, quantity: 1, unit_price: 1 }],
      supplier: '', type: 'other', remark: `${MARK} 跨仓`
    }, skParts)
    ok('A2 仓管跨仓建入库单被拒（403）', r.code === 403, brief(r))
  }

  // ---- 3. 仓管填供应商 → type=purchase
  {
    const r = await callRaw('inbound', 'submit', {
      warehouse_id: 1,
      items: [{ material_id: m1._id, quantity: 1, unit_price: 2 }],
      supplier: '测试供应商', type: 'purchase', remark: `${MARK} 带供应商`
    }, skParts)
    ok('A3 填供应商的入库单类型=purchase',
      r.code === 0, brief(r))
    if (r.code === 0) {
      const d = await callRaw('inbound', 'detail', { id: r.data._id }, skParts)
      ok('A3 单据确实记的 purchase', d.data && d.data.type === 'purchase', `type=${d.data && d.data.type}`)
    }
  }

  // ---- 4. 仓管新增物料：自己仓 OK / 跨仓 403
  {
    const okCreate = await callRaw('material', 'upsert', {
      name: `${MARK}后台建档物料`, spec: 'TEST-1', category: '配件',
      unit: '个', warning_stock: 10, warehouse_id: 1
    }, skParts)
    ok('A4 仓管在自己仓新增物料成功', okCreate.code === 0, brief(okCreate))
    const cross = await callRaw('material', 'upsert', {
      name: `${MARK}跨仓建档`, spec: 'TEST-2', category: '成品',
      unit: '个', warehouse_id: 2
    }, skParts)
    ok('A4 仓管跨仓建档被拒（403）', cross.code === 403, brief(cross))
  }

  // ---- 5. 厂长建成品仓出库（销售）→ 成功
  //   ⚠️ 出库与入库的扣账时机**不一样**：入库是提交即入账（A1 已验），
  //      出库是「确认收货」时才扣库存、置 stock_deducted=1（驳回/作废据此回补）。
  //      提交时库存不变 —— 别再写「提交即扣库存」这种判据（写反过一次）。
  let directorOrderId = null
  {
    const before = await stockOf(m2._id)
    const r = await callRaw('outbound', 'submit', {
      warehouse_id: 2,
      items: [{ material_id: m2._id, quantity: 1 }],
      type: 'sale', remark: `${MARK} 厂长成品仓出库`
    }, director)
    ok('A5 厂长建成品仓出库（销售）成功', r.code === 0, brief(r))
    directorOrderId = r.data && r.data._id
    const after = await stockOf(m2._id)
    ok('A5 提交后库存不变（出库在确认收货时才扣）', after === before, `${before} → ${after}`)
    const d = await callRaw('outbound', 'detail', { id: directorOrderId }, director)
    ok('A5 单据 pending 等仓管确认', d.data && d.data.status === 'pending',
      `status=${d.data && d.data.status}`)
  }

  // ---- 6. 厂长建配件仓出库 → 403 且提示语点名成品仓
  {
    const r = await callRaw('outbound', 'submit', {
      warehouse_id: 1,
      items: [{ material_id: m1._id, quantity: 1 }],
      type: 'sale', remark: `${MARK} 厂长碰配件仓`
    }, director)
    ok('A6 厂长建配件仓出库被拒（403）', r.code === 403, brief(r))
    ok('A6 提示语点名「成品仓」', String(r.message || '').includes('成品仓'), r.message)
  }

  // ---- 7. admin 建配件仓出库（维修）→ 成功
  {
    const r = await callRaw('outbound', 'submit', {
      warehouse_id: 1,
      items: [{ material_id: m1._id, quantity: 1 }],
      type: 'repair', remark: `${MARK} admin 代开维修出库`
    }, admin)
    ok('A7 admin 建配件仓出库（维修）成功', r.code === 0, brief(r))
  }

  // ---- 8. 领料员建入库单 → 403
  {
    const r = await callRaw('inbound', 'submit', {
      warehouse_id: 1,
      items: [{ material_id: m1._id, quantity: 1, unit_price: 1 }],
      supplier: '', type: 'other', remark: `${MARK} 领料员碰入库`
    }, outUser)
    ok('A8 领料员建入库单被拒（403）', r.code === 403, brief(r))
  }

  return { m2 }
}

/* ==================== B. 页面层 ==================== */

async function uiLayer() {
  console.log('\n===== B. 页面层（真实浏览器 + 真实后台账号） =====')
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

  async function login(user) {
    await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => { try { localStorage.clear() } catch (e) { /* 忽略 */ } })
    await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[placeholder="用户名"]', user)
    await page.fill('input[placeholder="密码"]', '123456')
    await page.click('.login-btn')
    await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 15000 })
    await sleep(1500)
  }

  // ⚠️ 折叠分组的子项 innerText 读不到（display:none）→ 按元素逐个读（与 batch2 的 sidebarState 同手法）
  const sidebarText = () => page.evaluate(() => {
    const menu = document.querySelector('.sidebar-menu')
    if (!menu) return ''
    const groups = Array.from(menu.querySelectorAll('.el-sub-menu__title')).map((n) => n.innerText.trim())
    const items = Array.from(menu.querySelectorAll('.el-menu-item')).map((n) => n.innerText.trim())
    return [...groups, ...items].join(' | ')
  })

  // ---- B1. 配件仓管：菜单与入库新建页
  await login('peijian')
  {
    const menu = await sidebarText()
    ok('B1 配件仓管菜单有「新建入库单」', menu.includes('新建入库单'))
    ok('B1 配件仓管菜单没有「成品仓出库」', !menu.includes('成品仓出库'), menu.slice(0, 120).replace(/\n/g, '|'))

    await page.goto(`${ADMIN_URL}/order/inbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(1800)
    const opts = await page.locator('.el-select__selected-item, .el-select__wrapper').allInnerTexts().catch(() => [])
    const bodyTxt = await page.evaluate(() => document.body.innerText)
    ok('B1 入库新建页渲染（有「选择物料」）', bodyTxt.includes('选择物料'))
    // 只配了一个仓 → 锁定
    // ⚠️ Element Plus 2.7 的禁用类挂在 .el-select__wrapper 上（不是 .el-select）——别选错层
    const locked = await page.locator('.el-select__wrapper.is-disabled').count()
    ok('B1 仓管的仓库选择被锁定（只管一个仓）', locked >= 1, `disabled select 数=${locked}`)

    // 真实走一遍：搜物料 → 加入 → 提交
    const firstRow = page.locator('.el-table__row').first()
    if (await firstRow.count()) {
      await firstRow.locator('button', { hasText: '加入' }).click()
      await sleep(600)
      const cartRows = await page.locator('.inner-card', { hasText: '入库清单' }).locator('.el-table__row').count()
      ok('B1 加入清单成功', cartRows >= 1, `清单行数=${cartRows}`)
      await page.fill('textarea', `${MARK} 后台页面验收-仓管入库`)
      await page.locator('button', { hasText: '提交入库单' }).click()
      await sleep(2000)
      const sk = await loginDev('dev_sk_parts')
      const lst = await callRaw('inbound', 'list', { page: 1, pageSize: 5 }, sk)
      const hit = (lst.data && lst.data.list || []).find((o) => String(o.remark || '').includes(MARK))
      ok('B1 页面提交的入库单真实生成', !!hit, `最新单 ${hit ? hit.order_no : '没找到'}`)
    } else {
      ok('B1 配件仓物料列表有数据', false, '列表为空')
    }
  }

  // ---- B2. 厂长：菜单与出库新建页（锁成品仓）
  await login('changzhang')
  {
    const menu = await sidebarText()
    ok('B2 厂长菜单有「成品仓出库」', menu.includes('成品仓出库'))
    ok('B2 厂长菜单没有「新建入库单」', !menu.includes('新建入库单'), menu.slice(0, 120).replace(/\n/g, '|'))

    await page.goto(`${ADMIN_URL}/order/outbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(1800)
    const bodyTxt = await page.evaluate(() => document.body.innerText)
    ok('B2 厂长看到的是「成品仓出库」模式条', bodyTxt.includes('成品仓出库') && bodyTxt.includes('拣完会通知你确认'))
    const locked = await page.locator('.el-select__wrapper.is-disabled').count()
    ok('B2 厂长的仓库选择被锁定（成品仓）', locked >= 1, `disabled select 数=${locked}`)
    const typeRadios = await page.locator('.el-radio').allInnerTexts()
    ok('B2 类型只有销售/领用',
      typeRadios.includes('销售') && typeRadios.includes('领用') && !typeRadios.includes('维修'),
      JSON.stringify(typeRadios))
    // 物料列表应该是成品仓的
    ok('B2 物料列表有数据（成品仓）', (await page.locator('.el-table__row').count()) > 0)

    // 真实走一遍：加入 → 选销售 → 提交
    const firstRow = page.locator('.el-table__row').first()
    if (await firstRow.count()) {
      await firstRow.locator('button', { hasText: '加入' }).click()
      await sleep(600)
      await page.locator('.el-radio', { hasText: '销售' }).click()
      await sleep(300)
      await page.fill('textarea', `${MARK} 后台页面验收-厂长出库`)
      await page.locator('button', { hasText: '提交出库' }).click()
      await sleep(2000)
      const director = await loginDev('dev_director')
      const lst = await callRaw('outbound', 'list', { page: 1, pageSize: 5 }, director)
      const hit = (lst.data && lst.data.list || []).find((o) => String(o.remark || '').includes(MARK))
      ok('B2 页面提交的出库单真实生成（厂长、成品仓、销售）',
        !!hit && hit.type === 'sale' && Number(hit.warehouse_id) === 2,
        `最新单 ${hit ? `${hit.order_no}/${hit.type}/wh${hit.warehouse_id}` : '没找到'}`)
    } else {
      ok('B2 成品仓物料列表有数据', false, '列表为空')
    }
  }

  // ---- B3. 厂长手敲入库新建页 → 被路由守卫弹回
  {
    await page.goto(`${ADMIN_URL}/order/inbound-create`, { waitUntil: 'domcontentloaded' })
    await sleep(1200)
    ok('B3 厂长手敲「新建入库单」被弹回', !page.url().includes('/order/inbound-create'), page.url())
  }

  await browser.close()
}

async function main() {
  await apiLayer()
  await uiLayer()

  console.log(`\n============================================================`)
  console.log(`断言：${pass + failures.length}，通过 ${pass}，失败 ${failures.length}`)
  console.log(`============================================================`)
  if (failures.length) {
    console.log('失败明细：')
    failures.forEach((f) => console.log(`  ❌ ${f.label}  ← ${f.detail}`))
  }
  return failures.length
}

let exitCode = 1
main()
  .then((f) => { exitCode = f ? 1 : 0 })
  .catch((e) => { console.error('套件异常：', e); exitCode = 1 })
  .finally(() => {
    autoCleanup()
    process.exit(exitCode)
  })
