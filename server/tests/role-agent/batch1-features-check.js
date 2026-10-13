/**
 * 2026-10-09 第一批需求验收：采购渠道/到货口径/厂长成品仓出库
 * ============================================================
 * 覆盖三块：
 *   A. 采购渠道扩到 1688/拼多多；选「其他」必须写说明（前后端都拦）
 *   B. myTodoCount 的「未结单」口径 = purchased + receiving
 *      —— 新口径下到货即入库，只数 purchased 会让角标在收货中途归零
 *   C. 厂长成品仓出库：只能开成品仓的单，且能走完 确认→拣货→厂长确认收货
 *
 * 用真实 HTTP 打真实服务，跑完自动清理（--no-cleanup 保留现场）。
 * ⚠️ 判据用「提交前后的增量」而不是「最近 N 分钟」，否则会吃到别的套件留下的数据。
 */
require('../../src/config/env')
const { loginDev, callRaw } = require('./lib')
const { query } = require('../../src/db/pool')
const { autoCleanup } = require('./_cleanup')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

async function main() {
  const sk = await loginDev('dev_sk_parts')       // 配件仓管（wh1）
  const skGoods = await loginDev('dev_sk_goods')  // 成品仓管（wh2）
  const buyer = await loginDev('dev_purchase')    // 采购员（wh1）
  const director = await loginDev('dev_director') // 厂长（wh1+wh2）

  // 取两个仓的物料各一条（仓管能看到库存，用他们的 token 取）
  const m1 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 }, sk)).data.list[0]
  const m2 = (await callRaw('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 2 }, skGoods)).data.list[0]
  if (!m1 || !m2) throw new Error('取不到测试物料（wh1/wh2 至少各要有一条物料）')
  console.log(`测试物料：wh1 #${m1._id} ${m1.name}（库存 ${m1.current_stock}） / wh2 #${m2._id} ${m2.name}（库存 ${m2.current_stock}）`)

  // 建一张采购任务并让采购员领取，返回 { id, items }
  async function makeTakenTask(qty = 2) {
    const c = await callRaw('purchase', 'create', {
      warehouse_id: 1,
      items: [{ material_id: m1._id, quantity: qty }],
      remark: 'BATCH1 验收'
    }, sk)
    if (c.code !== 0) throw new Error('建采购任务失败：' + c.message)
    const id = c.data._id
    const t = await callRaw('purchase', 'take', { id }, buyer)
    if (t.code !== 0) throw new Error('领取失败：' + t.message)
    const d = await callRaw('purchase', 'detail', { id }, buyer)
    return { id, item: d.data.items[0] }
  }

  // ============================================================
  console.log('\n== A1. 新渠道 1688 能提交 ==')
  {
    const { id, item } = await makeTakenTask(2)
    const r = await callRaw('purchase', 'entry', {
      id,
      items: [{ material_id: m1._id, unit_price: 9.9, purchase_channel: '1688', external_no: 'ALI-BATCH1' }]
    }, buyer)
    check('渠道「1688」提交成功', r.code === 0, JSON.stringify(r.message))
    const d = await callRaw('purchase', 'detail', { id }, buyer)
    check('明细落库为 1688', d.data.items[0].purchase_channel === '1688', d.data.items[0].purchase_channel)
    check('整单渠道也是 1688', String(d.data.purchase_channel).includes('1688'), d.data.purchase_channel)
    check('这条任务确实有明细 id', !!item && !!item._id)
  }

  console.log('\n== A2. 选「其他」不写说明必须被拒 ==')
  {
    const { id } = await makeTakenTask(2)
    const bad = await callRaw('purchase', 'entry', {
      id,
      items: [{ material_id: m1._id, unit_price: 5, purchase_channel: '其他' }]
    }, buyer)
    check('「其他」无说明 → 400', bad.code === 400, `code=${bad.code} ${bad.message}`)
    check('提示语点名了是哪一项', /其他/.test(String(bad.message)) && /补充说明/.test(String(bad.message)), bad.message)

    const ok = await callRaw('purchase', 'entry', {
      id,
      items: [{ material_id: m1._id, unit_price: 5, purchase_channel: '其他', channel_remark: '闲鱼二手' }]
    }, buyer)
    check('「其他」+ 说明 → 成功', ok.code === 0, ok.message)

    const d = await callRaw('purchase', 'detail', { id }, buyer)
    check('明细说明落库', d.data.items[0].channel_remark === '闲鱼二手', d.data.items[0].channel_remark)
    check('整单渠道带上说明（列表一眼能看出从哪买）',
      String(d.data.purchase_channel).includes('闲鱼二手'), d.data.purchase_channel)
  }

  console.log('\n== A3. 老渠道没被改坏 / 非法渠道被拦 ==')
  {
    const { id } = await makeTakenTask(2)
    const badC = await callRaw('purchase', 'entry', {
      id,
      items: [{ material_id: m1._id, unit_price: 5, purchase_channel: '天猫' }]
    }, buyer)
    check('不在白名单的渠道 → 400', badC.code === 400, `code=${badC.code} ${badC.message}`)

    const okC = await callRaw('purchase', 'entry', {
      id,
      items: [{ material_id: m1._id, unit_price: 5, purchase_channel: '拼多多' }]
    }, buyer)
    check('渠道「拼多多」提交成功', okC.code === 0, okC.message)
  }

  console.log('\n== B1. 采购员「新任务」计数（首页角标数据源）==')
  {
    const before = await callRaw('purchase', 'myTodoCount', {}, buyer)
    check('采购员返回 can_take 字段', before.code === 0 && typeof before.data.can_take === 'number', JSON.stringify(before.data))
    // 建一张不指定人的新任务 → 可领取数应 +1
    const base = Number(before.data.can_take)
    await callRaw('purchase', 'create', { warehouse_id: 1, items: [{ material_id: m1._id, quantity: 1 }], remark: 'BATCH1 角标' }, sk)
    const after = await callRaw('purchase', 'myTodoCount', {}, buyer)
    check('新建任务后 can_take +1', Number(after.data.can_take) === base + 1,
      `基线 ${base} → 现在 ${after.data.can_take}`)
  }

  console.log('\n== B2. 仓管「未结单」= 待收料 + 收货中 ==')
  {
    const base = await callRaw('purchase', 'myTodoCount', {}, sk)
    check('仓管分支返回 waiting_receive / receiving / total',
      base.code === 0 && base.data.waiting_receive !== undefined && base.data.receiving !== undefined,
      JSON.stringify(base.data))
    const baseTotal = Number(base.data.total)

    // 造一张「采购员已提交」的任务 → 进 purchased（待收料）
    const { id } = await makeTakenTask(3)
    await callRaw('purchase', 'entry', {
      id,
      items: [{ material_id: m1._id, unit_price: 8, purchase_channel: '线下' }]
    }, buyer)

    const s1 = await callRaw('purchase', 'myTodoCount', {}, sk)
    check('待收料时未结单 +1', Number(s1.data.total) === baseTotal + 1, `${baseTotal} → ${s1.data.total}`)
    check('待收料时 waiting_receive +1',
      Number(s1.data.waiting_receive) === Number(base.data.waiting_receive) + 1,
      `${base.data.waiting_receive} → ${s1.data.waiting_receive}`)

    // 到货入库把任务推进到 receiving（收货中）—— 这一步是关键：
    // 旧口径只数 purchased，此刻角标会归零
    const d = await callRaw('purchase', 'detail', { id }, sk)
    const item = d.data.items[0]
    const rec = await callRaw('purchase', 'receiveItem', {
      id, item_id: item._id, action: 'receive', received_qty: Number(item.quantity)
    }, sk)
    check('到货入库成功', rec.code === 0, rec.message)

    const s2 = await callRaw('purchase', 'myTodoCount', {}, sk)
    check('任务确实进了 receiving',
      (await callRaw('purchase', 'detail', { id }, sk)).data.status === 'receiving')
    check('收货中未结单没归零（口径已含 receiving）',
      Number(s2.data.total) === Number(s1.data.total),
      `待收料时 ${s1.data.total} → 收货中 ${s2.data.total}`)
    check('receiving 计数 +1',
      Number(s2.data.receiving) === Number(base.data.receiving) + 1,
      `${base.data.receiving} → ${s2.data.receiving}`)
  }

  console.log('\n== C1. 厂长只能开成品仓的单 ==')
  {
    // ⚠️ 判据不能只看 403：改动前 roleRules 根本没有 director，
    //    提交任何单都是 403 —— 那样这条用例改不改都"绿"，等于没测。
    //    所以必须认出是「新加的成品仓守卫」拒的（提示语点名成品仓）。
    const cross = await callRaw('outbound', 'submit', {
      type: 'lingyong', warehouse_id: 1, items: [{ material_id: m1._id, quantity: 1 }]
    }, director)
    check('厂长开配件仓出库被拒(403)', cross.code === 403, `code=${cross.code} ${cross.message}`)
    check('拒绝来自「成品仓守卫」而不是角色门（提示语点名成品仓）',
      /成品仓/.test(String(cross.message)), cross.message)

    const okWh2 = await callRaw('outbound', 'submit', {
      type: 'sale', warehouse_id: 2, items: [{ material_id: m2._id, quantity: 1 }]
    }, director)
    check('厂长开成品仓出库成功', okWh2.code === 0, `code=${okWh2.code} ${okWh2.message}`)
    check('新单状态为待确认', okWh2.data && okWh2.data._id !== undefined, JSON.stringify(okWh2.data))

    global.__dirOrderId = okWh2.data._id

    // 不传 warehouse_id 也不能绕过（物料归属才是最终事实）
    const cross2 = await callRaw('outbound', 'submit', {
      type: 'lingyong', items: [{ material_id: m1._id, quantity: 1 }]
    }, director)
    check('厂长不传仓库、直接塞配件仓物料也被拒(403)', cross2.code === 403, `code=${cross2.code} ${cross2.message}`)
    check('同样由成品仓守卫拦下（不是靠角色门）',
      /成品仓/.test(String(cross2.message)), cross2.message)
  }

  console.log('\n== C2. 成品仓管拣货 → 厂长确认收货 ==')
  {
    const oid = global.__dirOrderId
    const conf = await callRaw('outbound', 'confirm', { id: oid }, skGoods)
    check('成品仓管确认 → 进入待拣货', conf.code === 0 && conf.data.status === 'picking', JSON.stringify(conf.data || conf.message))

    // 厂长不能抢仓管的活
    const badConf = await callRaw('outbound', 'confirm', { id: oid }, director)
    check('厂长不能替仓管做确认(403)', badConf.code === 403, `code=${badConf.code} ${badConf.message}`)

    // 消息：确认后应通知厂长单据已被确认过？这里只校「拣货完成」那条（C3）
    const pick = await callRaw('outbound', 'pickDone', { id: oid }, skGoods)
    check('成品仓管拣货完成 → 待收货', pick.code === 0 && pick.data.status === 'receiving', JSON.stringify(pick.data || pick.message))

    const badPick = await callRaw('outbound', 'pickDone', { id: oid }, director)
    check('厂长不能替仓管标记拣货完成', badPick.code !== 0, `code=${badPick.code}`)

    await new Promise((r) => setTimeout(r, 600))
    const msg = await query(
      "SELECT COUNT(*) c FROM messages WHERE to_openid = 'dev_director' AND ref_no = (SELECT order_no FROM outbound_orders WHERE id = ?)",
      [oid]
    )
    check('拣货完成通知到了厂长（他要去确认收货）', Number(msg[0].c) >= 1, `消息数 ${msg[0].c}`)

    const recv = await callRaw('outbound', 'receive', { id: oid }, director)
    check('厂长确认收货 → 已完成', recv.code === 0, `${recv.code} ${recv.message}`)
    const d = await callRaw('outbound', 'detail', { id: oid }, director)
    check('单据终态 completed', d.data.status === 'completed', d.data.status)
    check('库存已扣减（stock_deducted=1）', Number(d.data.stock_deducted) === 1, d.data.stock_deducted)
  }

  console.log('\n== C3. 老角色没被改坏 ==')
  {
    // 配件仓管照样能开配件仓的单
    const r = await callRaw('outbound', 'submit', {
      type: 'lingyong', warehouse_id: 1, items: [{ material_id: m1._id, quantity: 1 }]
    }, sk)
    check('配件仓管照常提交 wh1 出库', r.code === 0, r.message)

    // 成品仓管照样能开成品仓的单
    const r2 = await callRaw('outbound', 'submit', {
      type: 'lingyong', warehouse_id: 2, items: [{ material_id: m2._id, quantity: 1 }]
    }, skGoods)
    check('成品仓管照常提交 wh2 出库', r2.code === 0, r2.message)
  }

  console.log(`\n========== 结果：${pass} 过 / ${fail} 挂 ==========`)
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
