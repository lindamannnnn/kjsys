/**
 * ============================================================
 * 真小程序审核（微信开发者工具模拟器 · miniprogram-automator）
 * ------------------------------------------------------------
 * 目的：H5 验收过了不代表小程序端没问题（uni 编译差异、原生组件行为不同），
 *   所有「这批新改动」都要在真小程序环境里被真实点一遍。
 *
 * 覆盖（对应这几天的全部改动）：
 *   A. 登录落点：5 个角色登录后都停在首页（不再有自动跳页）
 *   B. 首页卡片按角色收敛（领料员/采购员/仓管/厂长/老板各看到该看的）
 *   C. 采购员：「采购任务」角标 + 列表 tab 数字
 *   D. 采购录入：选「其他」冒说明框、空说明提交被拦（任务状态不变）
 *   E. 仓管：首页「仓管工作台」待办角标 + 工作台「采购任务」未结单角标
 *   F. 厂长：首页「成品仓出库」卡 → 锁成品仓 → 选类型 → 提交成功
 *      → 成品仓管拣货完成（API 代操作）→ 厂长消息中心收到通知 → 详情页确认收货
 *   G. 老板：首页没有「成品仓出库」卡（只读）
 *   H. 物料缩略图：无图显示占位框
 *
 * ⚠️ 前提：
 *   1. 开发者工具「设置 → 安全设置 → 服务端口」已开（本机 40044）
 *   2. 项目已用自动化模式打开：
 *      cli.bat auto --project G:\sl\shenglong-erp\miniprogram\dist\build\mp-weixin --auto-port 9420
 *   3. 后端 3000 在跑
 *
 * ⚠️ 会往真实库写数据（采购任务/出库单/消息），跑完 autoCleanup() 清掉。
 * ============================================================
 */
require('../../src/config/env')

const fs = require('fs')
const path = require('path')
const automator = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator')

const { callRaw, loginDev } = require('./lib')
const { autoCleanup } = require('./_cleanup')

const MP_API = process.env.MP_API || 'http://127.0.0.1:3000'   // 模拟器跑在本机，127.0.0.1 即可
const WS = process.env.MP_WS || 'ws://localhost:9420'
const MARK = '[MP-REVIEW]'
const SHOT_DIR = path.join(process.cwd(), 'tests/role-agent/results/mp-review')

let pass = 0
const failures = []
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else {
    failures.push({ label, detail })
    console.log(`  ❌ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------------------------------------------------------- 小程序侧工具 */

/** 换身份：写 dev_openid → 直连后端登录拿令牌 → 回首页 */
async function loginAs(mp, openid) {
  const code = await mp.evaluate(async ({ url, oid }) => {
    wx.setStorageSync('sl_dev_openid', oid)
    wx.removeStorageSync('sl_token')
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: `${url}/api/auth`,
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        data: { action: 'login', data: { dev_openid: oid } },
        success: (r) => resolve(r.data),
        fail: (e) => reject(new Error(JSON.stringify(e)))
      })
    })
    if (res && res.code === 0 && res.data && res.data.token) {
      wx.setStorageSync('sl_token', res.data.token)
      return 0
    }
    return (res && res.code) || -1
  }, { url: MP_API, oid: openid })
  if (code !== 0) throw new Error(`登录 ${openid} 失败 code=${code}`)
  await mp.reLaunch('/pages/index/index')
  await sleep(3500)
}

async function currentPath(mp) {
  const p = await mp.currentPage()
  return p.path
}

/** 首页角色卡片标题列表 */
async function cardTitles(page) {
  const els = await page.$$('.role-card')
  const out = []
  for (const el of els) {
    const t = await el.text()
    out.push((t || '').replace(/\s+/g, ''))
  }
  return out
}

async function shot(mp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `${name}.png`)
  await mp.screenshot({ path: file })
  return file
}

/** 找文本完全等于 label 的元素并点它（chip 场景，避免子串误命中） */
async function tapExact(page, selector, label) {
  const els = await page.$$(selector)
  for (const el of els) {
    const t = ((await el.text()) || '').trim()
    if (t === label) { await el.tap(); return true }
  }
  return false
}

/* ---------------------------------------------------------------- 造数（跑完 autoCleanup） */

async function setup() {
  const sk = await loginDev('dev_sk_parts')
  const buyer = await loginDev('dev_purchase')
  const m1 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, sk)).data.list[0]
  if (!m1) throw new Error('配件仓没有物料可用')

  async function createTask(qty) {
    const c = await callRaw('purchase', 'create', {
      warehouse_id: 1, items: [{ material_id: m1._id, quantity: qty }], remark: MARK
    }, sk)
    if (c.code !== 0) throw new Error('建任务失败：' + c.message)
    return c.data._id
  }

  // (a) open 任务 → 采购员首页角标
  await createTask(1)
  // (b) purchased 任务 → 仓管未结单角标
  const purchasedId = await createTask(2)
  await callRaw('purchase', 'take', { id: purchasedId }, buyer)
  await callRaw('purchase', 'entry', {
    id: purchasedId, items: [{ material_id: m1._id, unit_price: 3, purchase_channel: '线下' }]
  }, buyer)
  // (c) taken 任务归采购员 → 录入页 UI
  const takenId = await createTask(2)
  await callRaw('purchase', 'take', { id: takenId }, buyer)
  // (d) 待确认出库单 → 仓管首页待办角标
  const outUser = await loginDev('dev_out')
  const oc = await callRaw('outbound', 'submit', {
    warehouse_id: 1, items: [{ material_id: m1._id, quantity: 1 }], remark: MARK
  }, outUser)
  if (oc.code !== 0) throw new Error('建出库单失败：' + oc.message)

  return { m1, takenId }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const { takenId } = await setup()

  const mp = await automator.connect({ wsEndpoint: WS })

  try {
    /* ==================== A+B. 落点与卡片收敛 ==================== */
    console.log('\n=== A. 各角色登录后停在首页（不自动跳页） ===')
    const ROLES = [
      ['dev_out', '领料员', ['领料出库', '报废申请'], ['仓管工作台', '采购任务', '成品仓出库']],
      ['dev_purchase', '采购员', ['采购任务', '库存流水'], ['仓管工作台', '成品仓出库']],
      ['dev_sk_parts', '配件仓管', ['仓管工作台', '入库登记', '发起采购', '库存盘点'], ['成品仓出库']],
      ['dev_director', '厂长', ['经营看板', '成品仓出库', '发起采购', '库存盘点'], ['领料出库']],
      // 老板看板卡片的标题对老板是「老板看板」，对厂长是「经营看板」（同一页两个文案，刻意分开的）
      ['dev_boss', '老板', ['老板看板'], ['成品仓出库', '领料出库', '仓管工作台']]
    ]
    for (const [openid, name, must, mustNot] of ROLES) {
      await loginAs(mp, openid)
      const pathNow = await currentPath(mp)
      ok(`A ${name} 登录后停在首页工作台`, pathNow === 'pages/index/index', `实际 ${pathNow}`)
      const page = await mp.currentPage()
      const titles = await cardTitles(page)
      const all = titles.join('|')
      const miss = must.filter((t) => !all.includes(t))
      const leak = mustNot.filter((t) => all.includes(t))
      ok(`B ${name} 该看的卡片都在（${must.join('、')}）`, miss.length === 0, `缺 ${miss.join('、')}｜实际 ${all}`)
      ok(`B ${name} 不该看的一张都没有`, leak.length === 0, `多出 ${leak.join('、')}`)
      if (name === '厂长') await shot(mp, 'A-厂长首页')
    }

    /* ==================== C. 采购员角标 + tab 数字 ==================== */
    console.log('\n=== C. 采购员角标与 tab 数字 ===')
    await loginAs(mp, 'dev_purchase')
    let page = await mp.currentPage()
    const badge = await page.$('.role-card-purchase .role-badge')
    ok('C 首页「采购任务」卡片有角标', !!badge)
    if (badge) {
      const n = Number(((await badge.text()) || '').trim())
      ok('C 角标数字 ≥ 1（刚造了 open 任务）', n >= 1, `实际 ${n}`)
    }
    // 进任务列表看 tab 数字
    await page.$('.role-card-purchase').then((el) => el && el.tap())
    await sleep(3000)
    ok('C 点卡片进任务列表', (await currentPath(mp)) === 'pages/purchase/tasks', await currentPath(mp))
    page = await mp.currentPage()
    const tabs = await page.$$('.filter-tab')
    let tabWithCount = 0
    for (const t of tabs) {
      const c = await t.$('.tab-count')
      if (c) tabWithCount++
    }
    ok('C 列表 tab 上挂了数字', tabWithCount >= 1, `带数字的 tab 数=${tabWithCount}`)

    /* ==================== D. 采购录入「其他」必填说明 ==================== */
    console.log('\n=== D. 采购录入：选「其他」必填说明 ===')
    await mp.navigateTo(`/pages/purchase/task-detail?id=${takenId}`)
    await sleep(3000)
    page = await mp.currentPage()
    const countInputs = async () => (await page.$$('.entry-block input')).length
    const base = await countInputs()
    const clickedOther = await tapExact(page, '.chip-sm', '其他')
    await sleep(1000)
    const withOther = await countInputs()
    ok('D 选「其他」后多出说明输入框', clickedOther && withOther === base + 1, `${base} → ${withOther}`)

    // 不填说明直接提交 → 必须被拦（任务状态不进 purchased，就是没提交成功）
    // 录入页要先把单价填上（否则会先被「请填单价」拦住，测不到「其他」校验）
    const priceInputs = await page.$$('.entry-block input')
    if (priceInputs.length) await priceInputs[0].input('5')
    await sleep(400)
    const submitted = await tapExact(page, 'button', '提交采购信息')
    await sleep(1500)
    const afterBlank = await callRaw('purchase', 'detail', { id: takenId }, await loginDev('dev_purchase'))
    ok('D 空说明提交被拦（任务仍是采购中）',
      submitted && afterBlank.data && afterBlank.data.status === 'taken',
      `实际状态 ${afterBlank.data && afterBlank.data.status}（点了提交=${submitted}）`)

    /* ==================== E. 仓管角标 ==================== */
    console.log('\n=== E. 仓管角标 ===')
    await loginAs(mp, 'dev_sk_parts')
    page = await mp.currentPage()
    const skBadge = await page.$('.role-card-storekeeper .role-badge')
    ok('E 首页「仓管工作台」卡片有待办角标', !!skBadge)
    if (skBadge) {
      const n = Number(((await skBadge.text()) || '').trim())
      ok('E 待办数 ≥ 1（刚造了待确认出库单）', n >= 1, `实际 ${n}`)
    }
    await page.$('.role-card-storekeeper').then((el) => el && el.tap())
    await sleep(3000)
    ok('E 进仓管工作台', (await currentPath(mp)) === 'pages/storekeeper/dashboard', await currentPath(mp))
    page = await mp.currentPage()
    const menuCards = await page.$$('.menu-card')
    let pcBadgeTxt = ''
    for (const c of menuCards) {
      const t = ((await c.text()) || '')
      if (t.includes('采购任务')) {
        const b = await c.$('.badge')
        pcBadgeTxt = b ? ((await b.text()) || '').trim() : ''
      }
    }
    ok('E 工作台「采购任务」卡有未结单角标且 > 0', Number(pcBadgeTxt) > 0, `角标="${pcBadgeTxt}"`)

    /* ==================== F. 厂长成品仓出库全流程 ==================== */
    console.log('\n=== F. 厂长成品仓出库（首页发起 → 提交 → 通知 → 确认） ===')
    await loginAs(mp, 'dev_director')
    page = await mp.currentPage()
    const foCard = await page.$('.role-card-finishout')
    ok('F 厂长首页有「成品仓出库」卡片', !!foCard)
    if (foCard) {
      await foCard.tap()
      await sleep(3000)
      const p2 = await currentPath(mp)
      ok('F 点卡片进到出库页', /pages\/out\/submit/.test(p2), p2)
      page = await mp.currentPage()
      // 锁仓：切仓条不该在（只剩一个仓）
      const whBar = await page.$$('.wh-bar')
      ok('F 切仓条已隐藏（锁死成品仓）', whBar.length === 0, `wh-bar=${whBar.length}`)
      // 选一个物料进清单
      const mats = await page.$$('.material-item')
      ok('F 成品仓物料列表有数据', mats.length > 0, `count=${mats.length}`)
      if (mats.length) {
        await mats[0].tap()
        await sleep(1200)
        // ⚠️ mp 的 picker 是**原生组件**，automator 点不了滚轮，也读不到 bindchange
        //   （attribute('bindchange') 返回 null——事件绑定不是属性，探针 _probe-vm.js 取证）。
        //   可靠做法：从**磁盘上的产物 wxml** 里解析 picker 的 bindchange 数据键（如 D），
        //   再到页面实例上 cur.data.D 取处理器名、cur[name]({detail:{value:1}}) 调它——
        //   等价于用户真选了第 1 项「领用」，走完整事件链（含 onTypeChange 的 .value 修复）。
        const wxmlPath = path.resolve(__dirname, '../../../miniprogram/dist/build/mp-weixin/pages/out/submit.wxml')
        const wxml = fs.readFileSync(wxmlPath, 'utf8')
        const mPick = wxml.match(/<picker[^>]*class="picker[^"]*"[^>]*bindchange="\{\{(\w+)\}\}"/)
          || wxml.match(/<picker[^>]*bindchange="\{\{(\w+)\}\}"[^>]*class="picker/)
        ok('F 从产物 wxml 解析到 picker 的 change 绑定键', !!mPick, wxmlPath)
        let handlerName = ''
        if (mPick) {
          handlerName = await mp.evaluate((k) => {
            const cur = getCurrentPages().slice(-1)[0]
            if (!cur) return ''
            if (typeof cur[k] === 'function') return k
            if (cur.data && typeof cur.data[k] === 'string' && typeof cur[cur.data[k]] === 'function') {
              return cur.data[k]
            }
            return ''
          }, mPick[1])
        }
        ok('F 找到 picker 的 change 处理器', !!handlerName, `key=${mPick && mPick[1]} handler=${handlerName || '无'}`)
        if (handlerName) {
          await mp.evaluate((n) => {
            const cur = getCurrentPages().slice(-1)[0]
            cur[n]({ detail: { value: 1 } })   // 等价于用户选了「领用」
          }, handlerName)
        }
        await sleep(800)
        const pv = await page.$('.picker-value')
        const pvTxt = pv ? ((await pv.text()) || '').trim() : ''
        ok('F 选完类型后 picker 回显（不再是「请选择类型」）', !!pvTxt && !pvTxt.includes('请选择'), `回显="${pvTxt}"`)

        // ⚠️ 2026-10-13 补：提交前往「用途/备注」填上测试标记。
        //    之前没填 → 建出的单 remark 为空 → cleanup 认不出 → 单残留且扣的库存不回补
        //    （真实踩过：成品仓 OUT-20261013-002 残留，库存 1470→1469）。
        const remarkInputs = await page.$$('input')
        for (const el of remarkInputs) {
          const ph = await el.attribute('placeholder')
          if ((ph || '').includes('选填')) { await el.input(MARK); break }
        }
        await sleep(300)

        const submitEl = await page.$('.btn-submit')
        const disabled = submitEl ? await submitEl.attribute('disabled') : 'no-button'
        ok('F 提交按钮可点（清单+类型齐了）', String(disabled) !== 'true', `disabled=${disabled}`)
        if (submitEl && String(disabled) !== 'true') {
          await submitEl.tap()
          await sleep(2500)
          // 提交成功 → 页面会弹「领料单已提交」或跳走；用接口侧查单兜底确认
          const director = await loginDev('dev_director')
          const lst = await callRaw('outbound', 'list', { page: 1, pageSize: 10 }, director)
          const mine = (lst.data && lst.data.list || []).find((o) => String(o.remark || '').includes(MARK) && o.operator_openid === 'dev_director')
          const latest = (lst.data && lst.data.list || [])[0]
          ok('F 提交后出库单真的生成（接口侧能查到厂长的单）',
            !!latest && latest.operator_openid === 'dev_director' && latest.status === 'pending',
            `最新单 ${latest ? latest.order_no + '/' + latest.status + '/' + latest.operator_openid : '无'}`)
          global.__mpReviewOrderId = latest && latest._id

          /* ---- 仓管拣货（API 代操作）→ 厂长收到通知 → 详情页确认收货 ---- */
          if (global.__mpReviewOrderId) {
            const oid = global.__mpReviewOrderId
            const skg = await loginDev('dev_sk_goods')
            const c1 = await callRaw('outbound', 'confirm', { id: oid }, skg)
            const c2 = await callRaw('outbound', 'pickDone', { id: oid }, skg)
            ok('F 成品仓管确认+拣货完成（API 代操作）', c1.code === 0 && c2.code === 0,
              `confirm=${c1.code} pickDone=${c2.code} ${c1.message || ''}${c2.message || ''}`)

            // 厂长消息中心应收到「拣货完成」通知
            await loginAs(mp, 'dev_director')
            await mp.navigateTo('/pages/message/list')
            await sleep(2500)
            page = await mp.currentPage()
            const msgTxt = await page.$('.msg-list, .message-list, .container')
            const allMsg = msgTxt ? ((await msgTxt.text()) || '') : ''
            ok('F 厂长消息中心收到拣货完成通知', /拣货|完成/.test(allMsg), allMsg.slice(0, 80))

            // 进详情页：确认收货入口要在（最后一步的按钮渲染验证）
            await mp.navigateTo(`/pages/out/detail?id=${oid}`)
            await sleep(2500)
            page = await mp.currentPage()
            const recvBtn = await page.$('.btn-receive')
            ok('F 厂长详情页出现「确认收货」入口', !!recvBtn)
            await shot(mp, 'F-厂长待确认收货')
            // ⚠️ 点它会弹 uni.showModal（原生弹窗），automator 点不了弹窗按钮。
            //    「点按钮 → 收货完成」这一段已由 batch1-features-check.js 的 C 段
            //    在接口层完整覆盖（含厂长抢确认被拒、完成后 stock_deducted=1），
            //    这里只负责验证「通知到了、入口出现了」。
            //    收尾用接口把这单确认掉，让单据走完完整生命周期（顺便验证链路终态）。
            if (recvBtn) {
              const fin0 = await callRaw('outbound', 'receive', { id: oid }, await loginDev('dev_director'))
              const fin = await callRaw('outbound', 'detail', { id: oid }, await loginDev('dev_director'))
              ok('F 确认收货后单据完成且库存已扣（接口收口）',
                fin0.code === 0 && fin.data && fin.data.status === 'completed' && fin.data.stock_deducted === 1,
                `receive=${fin0.code} status=${fin.data && fin.data.status} deducted=${fin.data && fin.data.stock_deducted}`)
            }
          }
        }
      }
      await shot(mp, 'F-厂长出库页')
    }

    /* ==================== H. 物料缩略图占位 ==================== */
    console.log('\n=== H. 物料缩略图（无图占位） ===')
    await loginAs(mp, 'dev_out')
    await mp.navigateTo('/pages/out/submit')
    await sleep(3000)
    page = await mp.currentPage()
    const thumbs = await page.$$('.material-thumb')
    const emptyThumbs = await page.$$('.material-thumb-empty')
    ok('H 物料条目有缩略图位（无图显示占位框）',
      thumbs.length > 0 && emptyThumbs.length > 0,
      `thumb=${thumbs.length} 占位=${emptyThumbs.length}`)
  } finally {
    // disconnect() 不返回 Promise（返回 undefined），直接 .catch 会崩——先包一层
    try { await mp.disconnect() } catch (e) { /* 断开失败无所谓 */ }
  }

  console.log(`\n========== 真小程序审核结果：${pass} 过 / ${failures.length} 挂 ==========`)
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
  .finally(async () => {
    await autoCleanup()
    process.exit(exitCode)
  })
