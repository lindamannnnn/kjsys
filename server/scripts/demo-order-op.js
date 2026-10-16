/**
 * 演示单据辅助操作：确认 / 作废（走生产后端正规接口）
 *
 * 用法：
 *   ADMIN_PASS=xxx OP=confirm ORDER_ID=200 node demo-order-op.js
 *   ADMIN_PASS=xxx OP=cancel  ORDER_ID=<出库单id> node demo-order-op.js
 */
const BASE = process.env.API_BASE || 'https://sl.ekkosys.cn'
const ADMIN_PASS = process.env.ADMIN_PASS || ''
const OP = process.env.OP || ''
const ORDER_ID = Number(process.env.ORDER_ID || 0)
const MODULE = process.env.MODULE || 'inbound' // inbound | outbound
const REASON = process.env.REASON || '录屏演示单，清理用'

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
  if (!ORDER_ID) { console.error('缺少 ORDER_ID'); process.exit(1) }
  if (!['confirm', 'cancel'].includes(OP)) { console.error('OP 只能是 confirm / cancel'); process.exit(1) }

  const login = await call('auth', 'adminLogin', { username: process.env.ADMIN_USER || 'admin', password: ADMIN_PASS })
  if (!login.data || !login.data.token) { console.error('❌ 登录失败：', JSON.stringify(login)); process.exit(1) }
  const token = login.data.token
  console.log(`✅ 登录成功：${login.data.user?.real_name || 'admin'}`)

  const before = await call(MODULE, 'detail', { id: ORDER_ID }, token)
  console.log(`【操作前】${MODULE}#${ORDER_ID} status=${before.data?.status} no=${before.data?.order_no}`)

  const r = await call(MODULE, OP, { id: ORDER_ID, reason: REASON }, token)
  console.log(`【${OP} 结果】${JSON.stringify(r)}`)

  const after = await call(MODULE, 'detail', { id: ORDER_ID }, token)
  console.log(`【操作后】${MODULE}#${ORDER_ID} status=${after.data?.status}`)
}

main().catch((e) => { console.error('异常：', e); process.exit(1) })
