/**
 * ============================================================
 * 期初库存建账（正式启用第一步，2026-10-14 投产新增）
 * ------------------------------------------------------------
 * 背景：系统规矩是「库存只能通过入库单建立」（有流水、有责任人）。
 *   所以清 0 之后录期初库存，不是直接改数字，而是**按实盘生成「期初入库单」**。
 *
 * 用法：
 *   1. 盘点后，把实盘数填进 Excel 模板（期初库存导入模板.csv）：
 *        仓库,编号,名称,规格,实盘数量,期初单价
 *      - 配件仓的料填「编号」就能对上（如 A001-1）
 *      - 成品仓的料没编号，填「名称+规格」对上
 *      - 实盘数量 0 的行会跳过（不建账）
 *   2. 跑：
 *        node scripts/init-stock.js 期初库存导入模板.csv
 *      （默认连本地；连生产加环境变量 API_BASE=https://sl.ekkosys.cn，且用生产管理员账号）
 *
 * 它做什么：
 *   - 逐行按「编号 / 名称+规格 + 仓库」匹配已有物料（匹配不到的列出来让你核对）
 *   - 按仓分组，每仓生成一张「期初建账」入库单（走入库流程：加库存 + 写流水 + 记责任人）
 *   - 期初单价不填就用 0（金额后续以真实采购入库为准）
 *
 * ⚠️ 只在「清 0 之后、正式启用那一刻」跑一次。重复跑会重复加库存。
 * ============================================================
 */
require('../src/config/env')
const fs = require('fs')

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || '123456'

async function call(name, action, data = {}, token = '') {
  const res = await fetch(`${BASE}/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, data })
  })
  return res.json()
}

/** 解析 CSV（仓库,编号,名称,规格,实盘数量,期初单价） */
function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const rows = []
  for (const line of lines.slice(1)) {  // 跳过表头
    const c = line.split(/[,，]/).map((s) => s.trim())
    rows.push({
      warehouse: c[0] || '', no: c[1] || '', name: c[2] || '', spec: c[3] || '',
      qty: Number(c[4] || 0), price: c[5] === '' || c[5] === undefined ? 0 : Number(c[5])
    })
  }
  return rows
}

async function main() {
  const file = process.argv[2]
  if (!file || !fs.existsSync(file)) {
    console.log('用法：node scripts/init-stock.js <实盘CSV路径>')
    console.log('CSV 表头：仓库,编号,名称,规格,实盘数量,期初单价')
    process.exit(1)
  }
  console.log('=== 期初库存建账 ===')
  console.log('目标：', BASE)

  const login = await call('auth', 'adminLogin', { username: ADMIN_USER, password: ADMIN_PASS })
  if (!login.data || !login.data.token) { console.log('❌ 管理员登录失败：', login.message); process.exit(1) }
  const tok = login.data.token
  console.log('✓ 管理员登录成功')

  // 取全部物料（两仓）。⚠️ 接口单页上限 200，得翻页拿全（1907 条一次 5000 只回 200）
  let mats = []
  let page = 1
  while (true) {
    const mres = await call('material', 'list', { page, pageSize: 200 }, tok)
    const list = (mres.data && mres.data.list) || []
    mats = mats.concat(list)
    if (list.length < 200) break
    page++
  }
  const whres = await call('warehouse', 'list', {}, tok)
  const whs = (whres.data && whres.data.list) || []
  const whIdByName = {}
  for (const w of whs) whIdByName[w.name] = w._id || w.id

  const rows = parseCsv(file).filter((r) => r.qty > 0)
  console.log(`实盘行数（数量>0）：${rows.length}`)
  const DRY = process.argv.includes('--dry-run')
  if (DRY) console.log('（演练模式：只匹配核对，不实际建单）')

  // 匹配物料 + 按仓聚合
  const byWarehouse = {}
  const unmatched = []
  for (const r of rows) {
    const wid = whIdByName[r.warehouse]
    const mat = mats.find((m) => {
      const sameWh = String(m.warehouse_id) === String(wid)
      if (!sameWh) return false
      if (r.no) return String(m.material_no || '') === r.no
      return String(m.name) === r.name && String(m.spec || '') === r.spec
    })
    if (!mat) { unmatched.push(r); continue }
    if (!byWarehouse[wid]) byWarehouse[wid] = []
    byWarehouse[wid].push({ material_id: mat._id || mat.id, quantity: r.qty, unit_price: r.price, name: mat.name })
  }

  if (unmatched.length) {
    console.log(`\n⚠️ ${unmatched.length} 行没匹配到物料（请先核对编号/名称/规格/仓库）：`)
    unmatched.slice(0, 20).forEach((r) => console.log(`   - ${r.warehouse} ${r.no || r.name} ${r.spec}`))
    console.log('   修正后再跑。本次未建任何单据。\n')
    process.exit(1)
  }

  // 每仓生成一张期初入库单
  let totalQty = 0
  for (const [wid, items] of Object.entries(byWarehouse)) {
    const whName = Object.keys(whIdByName).find((k) => String(whIdByName[k]) === String(wid))
    const qty = items.reduce((s, i) => s + i.quantity, 0)
    if (DRY) {
      console.log(`  [演练] ${whName}：将建期初入库单，${items.length} 种料、共 ${qty} 件`)
      totalQty += qty
      continue
    }
    const res = await call('inbound', 'submit', {
      warehouse_id: Number(wid),
      items: items.map((i) => ({ material_id: i.material_id, quantity: i.quantity, unit_price: i.unit_price })),
      remark: '期初建账（正式启用实盘录入）'
    }, tok)
    if (res.code !== 0) { console.log(`❌ ${whName} 期初入库失败：`, res.message); process.exit(1) }
    totalQty += qty
    console.log(`✓ ${whName}：期初入库单已建，${items.length} 种料、共 ${qty} 件`)
  }

  console.log(`\n✅ 期初建账完成，共入库 ${totalQty} 件。库存流水里都有记录（责任人=管理员）。\n`)
  process.exit(0)
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
