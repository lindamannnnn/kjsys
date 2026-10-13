/**
 * 一次性：给「数据大屏」造一小批**带标记的演示数据**，用于验证有数据时各面板真的画得出来。
 * ⚠️ 跑完必须立刻 `node tests/cleanup-test-data.js --apply` 清掉。
 *
 * 造什么：
 *   3 个测试物料（名字以 [RA-SCR] 开头，会被清理脚本识别）
 *   1 张入库单（2 个明细，其中 1 个物料故意把预警线设高 → 进「库存预警」面板）
 *   1 张出库单（1 个明细）→ 让「物料排行」「单据流水」「库存流水」都有内容
 */
require('../server/src/config/env')
const http = require('http')
const BASE = 'http://127.0.0.1:3000/api'

function call(mod, action, data, token) {
  return new Promise((res, rej) => {
    const p = JSON.stringify({ action, data })
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) }
    if (token) h.Authorization = 'Bearer ' + token
    const r = http.request(BASE + '/' + mod, { method: 'POST', headers: h }, (x) => {
      let s = ''
      x.on('data', (c) => (s += c))
      x.on('end', () => { try { res(JSON.parse(s)) } catch (e) { res({ raw: s }) } })
    })
    r.on('error', rej); r.write(p); r.end()
  })
}

const TAG = '[RA-SCR]'
const WH = 1

;(async () => {
  const sk = await call('auth', 'login', { dev_openid: 'dev_sk_parts' })
  if (sk.code !== 0) { console.log('仓管登录失败', sk); return }
  const out = await call('auth', 'login', { dev_openid: 'dev_out' })
  if (out.code !== 0) { console.log('领料员登录失败', out); return }

  // 1) 建 3 个测试物料（第 2 个预警线设 100，入库 12 → 触发预警）
  const mats = [
    { name: `${TAG}演示物料A`, spec: 'DEMO-1', warning_stock: 5 },
    { name: `${TAG}演示物料B`, spec: 'DEMO-2', warning_stock: 100 },
    { name: `${TAG}演示物料C`, spec: 'DEMO-3', warning_stock: 5 }
  ]
  const ids = []
  for (const m of mats) {
    const r = await call('material', 'upsert', {
      name: m.name, spec: m.spec, category: '配件', unit: '个',
      warning_stock: m.warning_stock, warehouse_id: WH
    }, sk.data.token)
    if (r.code !== 0) { console.log('建物料失败', m.name, r.message); continue }
    ids.push(r.data._id)
  }
  console.log('物料已建:', ids.join(','))

  // 2) 入库单（2 明细）
  const inRes = await call('inbound', 'submit', {
    supplier: '演示供应商(忽略)',
    remark: `${TAG}大屏演示入库`,
    warehouse_id: WH,
    items: [
      { material_id: ids[0], quantity: 20, unit_price: 12.5 },
      { material_id: ids[1], quantity: 12, unit_price: 300 }
    ]
  }, sk.data.token)
  console.log('入库单:', inRes.code, inRes.message, inRes.data && inRes.data.order_no)

  // 3) 出库单（1 明细）
  const outRes = await call('outbound', 'submit', {
    type: 'lingyong',
    remark: `${TAG}大屏演示出库`,
    warehouse_id: WH,
    items: [{ material_id: ids[0], quantity: 6 }]
  }, out.data.token)
  console.log('出库单:', outRes.code, outRes.message, outRes.data && outRes.data.order_no)

  console.log('\n演示数据已就位。跑完大屏验收后务必执行：')
  console.log('  cd server && node tests/cleanup-test-data.js --apply')
})()
