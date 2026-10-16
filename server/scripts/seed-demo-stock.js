/**
 * 为「提审录屏」造演示库存 —— 走生产后端正规接口（inbound.submit），不直接改库。
 *
 * 为什么需要：生产库 1906 条物料 current_stock 全为 0，而后端在
 *   outbound 的 submit / confirm / pickDone 三处都调 assertStockEnough，
 *   库存为 0 时录屏第 4 段一点「提交出库」就报「库存不足」，走不下去。
 *
 * 设计要点（可回滚）：
 *   1. 单据 remark 带固定标记 `【录屏演示-可作废】` → 录完可按单 cancel 回补库存
 *   2. type='other'（无供应商）→ 不占用供应商对账口径
 *   3. unit_price=0 → 不影响金额类报表
 *   4. 提交前自检：目标物料库存必须仍为 0，否则中止（防重复建单叠加）
 *
 * 用法：ADMIN_PASS=xxx node seed-demo-stock.js
 */
const BASE = process.env.API_BASE || 'https://sl.ekkosys.cn'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || ''

// 挑名字好认、方便镜头里搜索演示的物料（配件仓 warehouse_id=1）
// ⚠️ unit_price 必须 > 0（后端硬校验：填 0 会让库存金额与成本核算失真）
//    这里用看起来合理的小额单价，录完作废时会「数量回退 + 成本冲回」，不留残留
const ITEMS = [
  { material_id: 274, material_name: '夹板',   quantity: 100, unit_price: 5 },
  { material_id: 247, material_name: '钢板膜', quantity: 100, unit_price: 8 },
  { material_id: 300, material_name: 'KA炉盘', quantity: 100, unit_price: 12 }
]

const MARKER = '【录屏演示-可作废】'

async function call(module, action, data = {}, token = '') {
  const res = await fetch(`${BASE}/api/${module}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ action, data })
  })
  return res.json()
}

async function main() {
  if (!ADMIN_PASS) { console.error('缺少 ADMIN_PASS'); process.exit(1) }

  const login = await call('auth', 'adminLogin', { username: ADMIN_USER, password: ADMIN_PASS })
  if (!login.data || !login.data.token) {
    console.error('❌ 管理员登录失败：', JSON.stringify(login)); process.exit(1)
  }
  const token = login.data.token
  console.log(`✅ 管理员登录成功：${login.data.user?.real_name || ADMIN_USER}`)

  // ⚠️ 提交前的「库存必须仍为 0」自检由外层 SQL 只读查询完成（见调用命令），
  //    防重复建单叠加；本脚本只负责提交，不做二次判断。
  const items = ITEMS.map((it) => ({
    material_id: it.material_id,
    material_name: it.material_name,
    quantity: it.quantity,
    unit_price: it.unit_price
  }))

  const r = await call('inbound', 'submit', {
    items,
    type: 'other',
    warehouse_id: 1,
    remark: `${MARKER} 提审录屏演示库存，录完可作废`
  }, token)

  console.log('\n【入库提交结果】', JSON.stringify(r))
  if (r.success === false || r.code) {
    console.error('\n❌ 入库提交失败，未产生任何数据')
    process.exit(1)
  }
  const d = r.data || {}
  console.log(`\n✅ 入库单已创建：id=${d._id} 单号=${d.order_no}`)
  console.log(`   物料：${ITEMS.map((i) => `${i.material_name} +${i.quantity}`).join(' / ')}`)
  console.log(`   标记：${MARKER}`)
}

main().catch((e) => { console.error('异常：', e); process.exit(1) })
