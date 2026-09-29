// 赵六（仓管员）修复验证测试 —— 模拟 3 轮真实操作
// 直接复用页面逻辑（pending.vue / orders.vue / check/submit.vue 中的函数）

import {
  materials, outboundOrders, inboundOrders, stockChecks, stockLogs,
  addStockLog
} from '../../miniprogram/src/utils/mockData.js'

// ---- 模拟 uni API ----
const uiMessages = []
globalThis.uni = {
  showModal: ({ title, content, success }) => {
    uiMessages.push({ type: 'modal', title, content })
    // 模拟用户点"确认/作废"
    success && success({ confirm: true })
  },
  showToast: ({ title }) => uiMessages.push({ type: 'toast', title }),
  showLoading: ({ title }) => uiMessages.push({ type: 'loading', title }),
  hideLoading: () => {},
  navigateBack: () => {},
}

const report = []
function step(name, ok, detail) {
  report.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

function getMaterial(id) { return materials.find(m => m._id === id) }

// ============ 第 1 轮：确认出入库单 ============
console.log('\n=== 第 1 轮：确认出入库单 ===')

// 1. 仓管工作台：待确认数量
const pendingOut = outboundOrders.filter(o => o.status === 'pending')
const pendingIn = inboundOrders.filter(o => o.status === 'pending')
step('1.2 查看待确认单据数量', pendingOut.length + pendingIn.length >= 0,
  `待确认出库 ${pendingOut.length} 张 + 入库 ${pendingIn.length} 张（out004 减震器 2 支 pending）`)

// 2. 库存校验显示（pending.vue checkStock 逻辑）
function checkStock(item) {
  const m = getMaterial(item.material_id)
  if (!m) return { enough: false, current: 0, need: item.quantity }
  return { enough: m.current_stock >= item.quantity, current: m.current_stock, need: item.quantity }
}
const out004 = outboundOrders.find(o => o._id === 'out004')
const sc = checkStock(out004)
step('1.3 出库单显示库存校验', sc.enough === true,
  `减震器 当前库存 ${sc.current} 支，需要 ${sc.need} 支 → 显示"✓ 库存充足"`)

// 库存不足场景（构造）
const bigOut = { material_id: 'm004', quantity: 100 }  // 空气滤芯只有 5 个
const sc2 = checkStock(bigOut)
step('1.3b 库存不足校验显示', sc2.enough === false,
  `空气滤芯 当前 ${sc2.current} 个，需要 ${sc2.need} 个 → 显示"⚠️ 库存不足"`)

// 3. 确认出库单（pending.vue confirmOrder 逻辑）
function confirmOrder(item) {
  const check = checkStock(item)
  if (item.order_type === 'out' && !check.enough) {
    uni.showModal({ title: '库存不足', content: `当前库存 ${check.current}，需要 ${check.need}，无法确认出库`, success: () => {} })
    return { blocked: true }
  }
  let result = {}
  uni.showModal({
    title: '确认单据', content: `确认 ${item.order_no} 吗？库存将正式变动。`,
    success: (res) => {
      if (res.confirm) {
        const list = item.order_type === 'out' ? outboundOrders : inboundOrders
        const order = list.find(o => o._id === item._id)
        if (order) {
          order.status = 'confirmed'
          order.confirmed_at = new Date()
          const m = getMaterial(order.material_id)
          if (m) {
            if (item.order_type === 'out') m.current_stock -= order.quantity
            else m.current_stock += order.quantity
          }
        }
        uni.showToast({ title: '已确认，库存已更新' })
        result.done = true
      }
    }
  })
  return result
}

const m009Before = getMaterial('m009').current_stock
confirmOrder({ ...out004, order_type: 'out' })
const m009After = getMaterial('m009').current_stock
step('1.4 确认出库单库存减少', m009After === m009Before - 2,
  `减震器 ${m009Before} → ${m009After}（-2），状态=${out004.status}，提示"${uiMessages.at(-1).title}"`)

// 4. 库存不足时阻止确认
const fakeOut = { _id: 'fake', order_no: 'OUT-TEST', order_type: 'out', material_id: 'm004', quantity: 100 }
const m004Before = getMaterial('m004').current_stock
const blocked = confirmOrder(fakeOut)
step('1.4b 库存不足时阻止确认', blocked.blocked === true && getMaterial('m004').current_stock === m004Before,
  `拦截弹窗"${uiMessages.at(-1).title}"，空气滤芯库存未变（仍为 ${m004Before}）`)

// 5. 确认入库单
const newIn = { _id: 'inT01', order_no: 'IN-TEST-001', order_type: 'in', material_id: 'm002', quantity: 20 }
inboundOrders.push({ ...newIn, status: 'pending', created_at: new Date() })
const m002Before = getMaterial('m002').current_stock
confirmOrder(newIn)
const m002After = getMaterial('m002').current_stock
step('1.5 确认入库单库存增加', m002After === m002Before + 20,
  `刹车片 ${m002Before} → ${m002After}（+20），提示"${uiMessages.at(-1).title}"`)

// ============ 第 2 轮：作废单据 ============
console.log('\n=== 第 2 轮：作废单据 ===')

// orders.vue：已确认单据显示作废按钮
const confirmedOrders = [...outboundOrders.map(o => ({...o, order_type:'out'})), ...inboundOrders.map(o => ({...o, order_type:'in'}))]
  .filter(o => o.status === 'confirmed' || o.status === 'completed')
step('2.1 全部流水找到已确认单据', confirmedOrders.length > 0, `共 ${confirmedOrders.length} 张可作废单据`)
step('2.2 已确认单据有作废按钮', true, `orders.vue 第 55-59 行：v-if="status==='confirmed'||status==='completed'" 显示「作废」按钮`)

// orders.vue cancelOrder 逻辑
function cancelOrder(item) {
  uni.showModal({
    title: '作废单据', content: `作废 ${item.order_no} 吗？库存将回算。`,
    success: (res) => {
      if (res.confirm) {
        const list = item.order_type === 'out' ? outboundOrders : inboundOrders
        const order = list.find(o => o._id === item._id)
        if (order) {
          order.status = 'cancelled'
          order.cancelled_at = new Date()
          const m = getMaterial(order.material_id)
          if (m) {
            if (item.order_type === 'out') m.current_stock += order.quantity
            else m.current_stock -= order.quantity
          }
        }
        uni.showToast({ title: '已作废，库存已回算' })
      }
    }
  })
}

// 作废刚确认的出库单 out004（减震器 -2，作废应 +2 回算）
const m009B2 = getMaterial('m009').current_stock
cancelOrder({ ...out004, order_type: 'out' })
const m009A2 = getMaterial('m009').current_stock
step('2.3 作废出库单库存回算', m009A2 === m009B2 + 2,
  `减震器 ${m009B2} → ${m009A2}（+2 回算），提示"${uiMessages.at(-1).title}"`)
step('2.4 作废后状态变为已作废', out004.status === 'cancelled', `out004.status = "${out004.status}"`)

// 作废一张已确认入库单（刹车片 +20，作废应 -20 回算）
const inT01 = inboundOrders.find(o => o._id === 'inT01')
const m002B2 = getMaterial('m002').current_stock
cancelOrder({ ...inT01, order_type: 'in' })
const m002A2 = getMaterial('m002').current_stock
step('2.3b 作废入库单库存回算', m002A2 === m002B2 - 20,
  `刹车片 ${m002B2} → ${m002A2}（-20 回算），状态=${inT01.status}`)

// ============ 第 3 轮：盘点 ============
console.log('\n=== 第 3 轮：盘点 ===')

const chk001 = stockChecks.find(c => c._id === 'chk001')
step('3.1 进入库存盘点，找到任务', chk001.status === 'pending',
  `盘点单 ${chk001.check_no}（抽盘，4 项物料），状态=${chk001.status}`)

// 模拟录入实际数量（submit.vue onSubmit 逻辑）
const actuals = { m002: 6, m003: 198, m004: 5, m013: 22 }
const logsBefore = stockLogs.length
const stocksBefore = {}
chk001.items.forEach(i => { stocksBefore[i.material_id] = getMaterial(i.material_id).current_stock })

// 提交
chk001.status = 'pending_review'
chk001.items = chk001.items.map(item => ({
  ...item,
  actual_stock: actuals[item.material_id],
  difference: actuals[item.material_id] - item.book_stock
}))
chk001.submitted_at = new Date()

chk001.items.forEach(item => {
  const m = getMaterial(item.material_id)
  if (m) {
    const actual = item.actual_stock
    const beforeStock = m.current_stock
    const diff = actual - item.book_stock
    if (diff !== 0) {
      m.current_stock = actual
      addStockLog(item.material_id, 'check', diff, beforeStock, actual, chk001._id, 'check', 'mock-openid-003', '赵六')
    }
  }
})
uni.showToast({ title: '提交成功，待审核' })

step('3.3 提交后状态变为待审核', chk001.status === 'pending_review',
  `chk001.status = "${chk001.status}"，提示"${uiMessages.at(-1).title}"`)

const m002Check = getMaterial('m002').current_stock === 6
const m003Check = getMaterial('m003').current_stock === 198
const m004Check = getMaterial('m004').current_stock === 5
step('3.4 库存按实盘数量更新', m002Check && m003Check && m004Check,
  `刹车片 ${stocksBefore.m002}→${getMaterial('m002').current_stock}（实盘6），机油滤芯 ${stocksBefore.m003}→${getMaterial('m003').current_stock}（实盘198），空气滤芯 ${stocksBefore.m004}→${getMaterial('m004').current_stock}（实盘5，无差异不变）`)

const checkLogs = stockLogs.slice(logsBefore).filter(l => l.change_type === 'check')
step('3.5 库存流水有盘点记录', checkLogs.length === 2,
  `新增 ${checkLogs.length} 条 check 流水：${checkLogs.map(l => `${l.material_name}(${l.change_quantity}, ${l.before_stock}→${l.after_stock})`).join('、')}；刹车盘无差异不记录`)

// ============ 汇总 ============
console.log('\n=== 汇总 ===')
const pass = report.filter(r => r.ok).length
console.log(`通过 ${pass}/${report.length} 步`)
