/**
 * ============================================================
 * 2026-10-09 第一批需求 · 页面层验证（真实浏览器跑道）
 * ------------------------------------------------------------
 * 为什么单独有这一个：接口层已被 batch1-features-check.js 覆盖 38 项，
 * 但「接口对」不等于「页面能用」——角标到底有没有出现、选「其他」会不会
 * 冒出说明框、厂长点进成品仓出库是不是真锁了仓，只有真点一遍才知道。
 *
 * 验收口径：
 *   ① 采购员登录后停在首页（2026-10-09 已取消自动跳页），「采购任务」卡片右上角有数字角标
 *   ② 采购任务列表「待领取」tab 上挂数字
 *   ③ 仓管工作台「采购任务」卡片右上角有未结单角标
 *   ③b 仓管登录后停在首页，「仓管工作台」卡片右上角有待办角标（待确认+待拣货）
 *   ④ 采购录入选「其他」→ 冒出必填说明框；改选「1688」→ 说明框收起
 *   ⑤ 厂长首页有「成品仓出库」入口卡；点进去锁定成品仓（无切仓条）、有模式提示条
 *      （2026-10-10 起入口在首页 index，不在经营看板）
 *   ⑥ 老板首页**没有**这个入口（老板只读）
 *
 * 用法（⚠️ H5 静态服务必须与本脚本在同一条 Bash 命令里起，否则命令结束进程被回收）：
 *   cd server
 *   node tests/role-agent/static-serve.js ../miniprogram/dist/build/h5 5174 & sleep 2
 *   node tests/role-agent/batch1-ui-check.js
 *   kill %1
 *
 * ⚠️ 口径说明：跑的是 **H5 产物**，只能作「交互逻辑 / 文案」证据，
 *    不能当小程序已验收（小程序以 mp-weixin 包 + 开发者工具为准）。
 * ============================================================
 */
require('../../src/config/env')

let chromium
try {
  chromium = require('playwright-core').chromium
} catch (e) {
  chromium = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/@playwright/cli/node_modules/playwright-core').chromium
}

const { loginDev, callRaw } = require('./lib')
const { autoCleanup } = require('./_cleanup')

const H5_URL = process.env.H5_URL || 'http://127.0.0.1:5174'
const MARK = 'BATCH1-UI'

let pass = 0, fail = 0
function check(section, label, cond, level = 'P1', detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/**
 * 点一个「文字完全等于 label」的元素。
 * ⚠️ 不能用 text=其他 —— Playwright 的 text= 是**子串**匹配，而本页说明文案
 *    「选『其他』的要逐项写明从哪里买」也含这两个字，会点错元素（点击"成功"但没反应）。
 *    这里用 Playwright 的 filter + 锚定正则，落点唯一。
 */
async function clickExactChip(page, label) {
  const loc = page.locator('.chip-sm').filter({ hasText: new RegExp(`^${label}$`) })
  const n = await loc.count()
  if (!n) return false
  await loc.first().click()
  return true
}

async function main() {
  // ---------- 造数据（跑完由 autoCleanup 清）----------
  const sk = await loginDev('dev_sk_parts')
  const buyer = await loginDev('dev_purchase')
  const m1 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, sk)).data.list[0]
  if (!m1) throw new Error('配件仓没有物料可用')

  async function createTask(qty = 2) {
    const c = await callRaw('purchase', 'create', {
      warehouse_id: 1, items: [{ material_id: m1._id, quantity: qty }], remark: MARK
    }, sk)
    if (c.code !== 0) throw new Error('建任务失败：' + c.message)
    return c.data._id
  }

  // (a) 一张 open（给采购员当新任务角标）
  await createTask(1)
  // (b) 一张 purchased（给仓管当未结单角标）
  const purchasedId = await createTask(2)
  await callRaw('purchase', 'take', { id: purchasedId }, buyer)
  await callRaw('purchase', 'entry', {
    id: purchasedId,
    items: [{ material_id: m1._id, unit_price: 3, purchase_channel: '线下' }]
  }, buyer)
  // (c) 一张 taken 且归采购员（给渠道选项 UI 用）
  const takenId = await createTask(2)
  await callRaw('purchase', 'take', { id: takenId }, buyer)

  // (d) 一张待确认的出库单（给首页「仓管工作台」卡片的待办角标用）：
  //     2026-10-09 取消自动跳页后，仓管不进工作台也要能在首页看到待办数。
  const outUser = await loginDev('dev_out')
  const oc = await callRaw('outbound', 'submit', {
    warehouse_id: 1, items: [{ material_id: m1._id, quantity: 1 }], remark: MARK
  }, outUser)
  if (oc.code !== 0) throw new Error('建出库单失败：' + oc.message)

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    // ================================================== ① 采购员：首页角标
    console.log('\n=== ① 采购员首页「采购任务」右上角数字角标 ===')
    {
      const page = await openAs(browser, 'dev_purchase', '/pages/index/index')
      // 2026-10-09 改版：取消「登录后自动推进某个页面」（utils/role-home.js 已删），
      // 所有角色登录后都停在首页工作台（首页按角色只显示自己的入口卡片），
      // 角标直接在首页看。
      // ⚠️ 「停在首页」这条是回归防线：以后谁把自动跳页加回来，这里立刻红。
      //    历史包袱：旧版断言过「自动落到任务列表」，配套注释里写过
      //    「不能用 page.evaluate(history.back())」（会触发真实导航、
      //    报 Execution context was destroyed）——那段 goBack 逻辑已随改版删除。
      const landedUrl = page.url()
      check('①', '采购员登录后停在首页工作台（不再有自动跳页）',
        /pages\/index\/index/.test(landedUrl), 'P1', landedUrl)

      const badgeCount = await page.locator('.role-badge').count()
      check('①', '首页采购任务卡片出现角标元素', badgeCount >= 1, 'P1', `count=${badgeCount}`)
      if (badgeCount) {
        const txt = (await page.locator('.role-badge').first().innerText()).trim()
        check('①', '角标是数字且大于 0', /^\d+$/.test(txt) && Number(txt) > 0, 'P1', `txt="${txt}"`)
      } else {
        check('①', '角标是数字且大于 0', false, 'P1', '角标元素都没出现')
      }
      // 角标必须落在「采购任务」卡片里，不能飘到别的卡上
      const insideCard = await page.locator('.role-card-purchase .role-badge').count()
      check('①', '角标挂在「采购任务」卡片内（不是别的卡）', insideCard >= 1, 'P1', `count=${insideCard}`)
      await page.close()
    }

    // ================================================== ② 采购员：列表 tab 数字
    console.log('\n=== ② 采购任务列表「待领取」tab 数字 ===')
    {
      const page = await openAs(browser, 'dev_purchase', '/pages/purchase/tasks')
      const tabTxt = await page.locator('.filter-tab').first().innerText().catch(() => '')
      const countTxt = await page.locator('.filter-tab .tab-count').first().innerText().catch(() => '')
      check('②', '「待领取」tab 上有数字', /^\d+$/.test(String(countTxt).trim()), 'P1', `tab="${tabTxt}" count="${countTxt}"`)
      check('②', '数字大于 0（确实有新任务）', Number(countTxt) > 0, 'P1', `count="${countTxt}"`)
      await page.close()
    }

    // ================================================== ③ 仓管：工作台角标
    console.log('\n=== ③ 仓管工作台「采购任务」未结单角标 ===')
    {
      const page = await openAs(browser, 'dev_sk_parts', '/pages/storekeeper/dashboard')
      // 采购任务卡片的角标：定位到含「采购任务」标题的 menu-card
      const cardHasBadge = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.menu-card'))
        const hit = cards.find((c) => (c.innerText || '').indexOf('采购任务') >= 0)
        if (!hit) return { found: false }
        const b = hit.querySelector('.badge')
        return { found: true, hasBadge: !!b, txt: b ? (b.innerText || '').trim() : '' }
      })
      check('③', '找到「采购任务」卡片', cardHasBadge.found, 'P1', JSON.stringify(cardHasBadge))
      check('③', '该卡片右上角有角标', !!cardHasBadge.hasBadge, 'P1', JSON.stringify(cardHasBadge))
      check('③', '角标数字大于 0', Number(cardHasBadge.txt) > 0, 'P1', `txt="${cardHasBadge.txt}"`)
      await page.close()
    }

    // ================================================== ③b 仓管：首页「仓管工作台」待办角标
    console.log('\n=== ③b 仓管首页「仓管工作台」待办角标（取消自动跳页后的替代显示） ===')
    {
      const page = await openAs(browser, 'dev_sk_parts', '/pages/index/index')
      check('③b', '仓管登录后停在首页工作台（不再有自动跳页）',
        /pages\/index\/index/.test(page.url()), 'P1', page.url())
      const cardBadge = await page.evaluate(() => {
        const card = document.querySelector('.role-card-storekeeper')
        if (!card) return { found: false }
        const b = card.querySelector('.role-badge')
        return { found: true, hasBadge: !!b, txt: b ? (b.innerText || '').trim() : '' }
      })
      check('③b', '首页有「仓管工作台」卡片', cardBadge.found, 'P1', JSON.stringify(cardBadge))
      check('③b', '卡片右上角有待办角标', !!cardBadge.hasBadge, 'P1', JSON.stringify(cardBadge))
      check('③b', '待办数 ≥ 1（刚造的待确认出库单）', Number(cardBadge.txt) >= 1, 'P1', `txt="${cardBadge.txt}"`)
      await page.close()
    }

    // ================================================== ④ 选「其他」冒出说明框
    console.log('\n=== ④ 采购录入：选「其他」必填说明 ===')
    {
      const page = await openAs(browser, 'dev_purchase', `/pages/purchase/task-detail?id=${takenId}`)
      // ⚠️ 不能拿 `input[placeholder="..."]` 去数说明框：uni-app 在 H5 里把占位文字
      //    渲染成**旁边一个 .uni-input-placeholder 的 div**，<input> 自己根本没有
      //    placeholder 属性 —— 用它数永远是 0，会把「选其他没冒说明框」误报成缺陷
      //    （2026-10-09 踩到）。改数 .entry-block 里的 input 个数：不含说明 2 个
      //    （单价 + 外部单号），选了「其他」变 3 个。
      const inputCount = () => page.locator('.entry-block input').count()
      const remarkHintCount = () => page
        .locator('.entry-block .uni-input-placeholder', { hasText: '写明具体从哪买的' }).count()

      const baseInputs = await inputCount()
      check('④', '默认（未选渠道）只有 单价/外部单号 两个输入框', baseInputs === 2, 'P1', `count=${baseInputs}`)
      check('④', '默认不显示说明提示', (await remarkHintCount()) === 0, 'P1')
      check('④', '渠道里有「1688」选项', (await page.locator('.chip-sm').filter({ hasText: /^1688$/ }).count()) > 0, 'P1')
      check('④', '渠道里有「拼多多」选项', (await page.locator('.chip-sm').filter({ hasText: /^拼多多$/ }).count()) > 0, 'P1')

      const clickedOther = await clickExactChip(page, '其他')
      await page.waitForTimeout(800)
      check('④', '点到「其他」chip', clickedOther, 'P1')
      const withOther = await inputCount()
      check('④', '选「其他」后多出说明输入框', withOther === baseInputs + 1, 'P1',
        `${baseInputs} → ${withOther}`)
      check('④', '说明框的提示语正确', (await remarkHintCount()) >= 1, 'P1')
      check('④', '「其他」chip 呈选中态',
        (await page.locator('.chip-sm.active').filter({ hasText: /^其他$/ }).count()) >= 1, 'P1')

      const clicked1688 = await clickExactChip(page, '1688')
      await page.waitForTimeout(800)
      const afterSwitch = await inputCount()
      // ⚠️ 断言不能只写「换回 1688 后说明框消失」—— 若上一步压根没出现，
      //    这条会因为「本来就是 0」而假绿。必须先确认上一步真出现过。
      check('④', '改选「1688」后说明框收起',
        clicked1688 && withOther === baseInputs + 1 && afterSwitch === baseInputs, 'P1',
        `clicked=${clicked1688} withOther=${withOther} after=${afterSwitch}`)
      await page.close()
    }

    // ================================================== ⑤ 厂长：成品仓出库入口
    console.log('\n=== ⑤ 厂长首页「成品仓出库」→ 锁定成品仓 ===')
    {
      // 2026-10-10 改版：入口从「经营看板」挪到首页（pages/index/index）。
      //   原因：取消自动跳页后首页才是厂长的落点，发起动作不该藏在看板里。
      const page = await openAs(browser, 'dev_director', '/pages/index/index')
      check('⑤', '厂长登录后停在首页工作台（不再有自动跳页）',
        /pages\/index\/index/.test(page.url()), 'P1', page.url())
      // 首页上应该同时有「经营看板」和「成品仓出库」两张卡
      const hasBoardCard = await page.locator('.role-card-boss').count()
      check('⑤', '首页有「经营看板」卡片', hasBoardCard >= 1, 'P1', `count=${hasBoardCard}`)
      const hasEntry = await page.locator('.role-card-finishout').count()
      check('⑤', '首页有「成品仓出库」入口卡片', hasEntry >= 1, 'P1', `count=${hasEntry}`)
      check('⑤', '入口文案正确', (await pageText(page)).includes('成品仓出库'), 'P1')

      if (hasEntry) {
        await page.locator('.role-card-finishout').first().click()
        await page.waitForTimeout(3000)
        const txt = await pageText(page)
        check('⑤', '点进后页面标题是成品仓出库模式', txt.includes('成品仓出库'), 'P1', txt.slice(0, 120).replace(/\n/g, '|'))
        check('⑤', '有模式说明条（提交后由成品仓管拣货）', txt.includes('成品仓管拣货'), 'P1')
        // 锁定仓库 → 只剩一个仓 → 切仓条按 v-if="warehouses.length > 1" 消失
        const whBar = await page.locator('.wh-bar').count()
        check('⑤', '切仓条已隐藏（仓库被锁死）', whBar === 0, 'P1', `wh-bar count=${whBar}`)

        // 出库类型的 picker 只在「清单非空」时才渲染，先加一个成品进清单
        const matCount = await page.locator('.material-item').count()
        check('⑤', '成品仓物料列表有数据（能选货）', matCount > 0, 'P1', `count=${matCount}`)
        if (matCount > 0) {
          await page.locator('.material-item').first().click()
          await page.waitForTimeout(1500)
        }

        // 出库类型选项：⚠️ 不能拿 body.innerText 找「销售」——
        //   uni-app 的 picker 是一个隐藏容器，innerText 取不到隐藏文字（误报过一次）。
        //   选项其实在 DOM 里（.uni-picker-item），直接读它们的文案。
        const opts = await page.locator('.uni-picker-item').allInnerTexts()
        check('⑤', '出库类型含「销售」（成品出库口径）', opts.includes('销售'), 'P1', JSON.stringify(opts))
        check('⑤', '出库类型含「领用」', opts.includes('领用'), 'P1', JSON.stringify(opts))
        check('⑤', '出库类型不再含「维修」（那是配件线口径）', !opts.includes('维修'), 'P2', JSON.stringify(opts))

        // ⚠️ 「选项存在」≠「能选上」——2026-10-10 真机事故：
        //   outTypes 从常量数组改成 computed 后，onTypeChange 里还在用 `outTypes[i]`
        //   取下标（忘了 .value）→ 选了也存不进去 → selectedType 永远空 → 提交按钮永远灰。
        //   H5 验收当时只看了选项在不在，没真点过 → 漏网。
        //   这里必须真点一次 picker、选「领用」、确定，再验证：
        //   ① picker 回显选中的文字；② 提交按钮从禁用变成可点。
        await page.locator('.picker').first().click()
        await page.waitForTimeout(800)
        // ⚠️ 这个 picker 在 H5 下是**平铺列表**（.uni-picker-select），点哪个就直接提交哪个、
        //    没有「完成」按钮（header 在 DOM 里但 0x0，uni-h5 源码：select 项 onClick 直接 _change()）。
        //    且页面里同时存在隐藏的一套 .uni-picker-content（滚轮副本），必须加 :visible。
        //    对照实验实锤：在未修复的包上，点「领用」后 picker-value 仍是「请选择类型」——
        //    正是用户真机上报的「选不了类型」。
        const visibleItems = page.locator('.uni-picker-select .uni-picker-item')
        const pickPanel = await visibleItems.count()
        check('⑤', '点「请选择类型」能展开 picker', pickPanel > 0, 'P1', `可见选项数=${pickPanel}`)
        if (pickPanel > 0) {
          // 默认第 0 项是「销售」，刻意选「领用」才能证明选择动作真的生效
          await visibleItems.filter({ hasText: '领用' }).first().click()
          await page.waitForTimeout(600)
          const pv = (await page.locator('.picker-value').first().innerText()).trim()
          check('⑤', '选完类型后 picker 回显「领用」', pv.includes('领用'), 'P1', `回显="${pv}"`)
          // ⚠️ .btn-submit 是 <uni-button> 自定义元素，不是原生 button ——
          //    Playwright 的 isDisabled() 只认原生表单控件，对它**恒 false**（差点假绿）。
          //    真实渲染是 disabled="true" 属性（探针 _probe-btn.js 取证）。
          const disabledAttr = await page.locator('.btn-submit').getAttribute('disabled')
          check('⑤', '提交按钮变为可点（清单+类型都齐了）', disabledAttr === null, 'P1',
            `disabled 属性=${JSON.stringify(disabledAttr)}`)
        }
      }
      await page.close()
    }

    // ================================================== ⑥ 老板不该有写入口
    console.log('\n=== ⑥ 对照组：老板首页没有「成品仓出库」 ===')
    {
      // 老板只读：首页不给「成品仓出库」卡片，看板里也没有（已随入口一起挪走）。
      const page = await openAs(browser, 'dev_boss', '/pages/index/index')
      const hasEntry = await page.locator('.role-card-finishout').count()
      check('⑥', '老板首页没有成品仓出库入口（只读）', hasEntry === 0, 'P0', `count=${hasEntry}`)
      await page.close()
    }
  } finally {
    await browser.close()
  }

  console.log(`\n========== 页面层结果：${pass} 过 / ${fail} 挂 ==========`)
  return fail
}

let exitCode = 1
main()
  .then((f) => { exitCode = f ? 1 : 0 })
  .catch((e) => { console.error('套件异常：', e); exitCode = 1 })
  .finally(() => {
    autoCleanup()
    process.exit(exitCode)
  })
