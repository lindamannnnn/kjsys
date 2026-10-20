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

/**
 * 解析 CSV（仓库,编号,名称,规格,实盘数量,期初单价）
 *
 * ⚠️ 2026-10-20 重写，原实现是 `line.split(/[,，]/)`，有两个真实故障：
 *   ① **只认 ASCII 逗号当分隔符**，原来连中文逗号「，」也当分隔符 →
 *      名称「蒸柜门扣线割，攻牙」、规格「牛仔，布」会被劈成两列，整行错位。
 *   ② **不认双引号**，Excel 保存的「"同昌80A-电极,电咀"」会被拆成 `"同昌80A-电极` + `电咀"`。
 *   这两类错位会表现为「未匹配」→ 脚本整体中止（还算安全），但只要凑巧撞上一个同名前缀的料，
 *   就会**静默记到别的物料头上**。所以按 RFC4180 重写：只有 ASCII 逗号是分隔符，
 *   双引号包裹的字段里逗号/换行都是内容，`""` 表示一个引号，并去掉 UTF-8 BOM。
 */
function parseCsv(file) {
  let text = fs.readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 去 BOM（Excel 导出的 CSV 带）

  const records = []
  let cur = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cur.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      cur.push(field); field = ''
      records.push(cur); cur = []
    } else field += ch
  }
  if (field !== '' || cur.length) { cur.push(field); records.push(cur) }

  const bad = []
  const rows = records.slice(1) // 跳过表头
    .filter((c) => c.some((s) => String(s).trim() !== ''))
    .map((c, idx) => {
      const line = idx + 2 // 表头算第 1 行
      // 列数必须正好 6。多出来的列说明某个字段里有逗号却没加双引号
      // （在 Excel 里直接敲 1,000 就会这样）→ 这样 c[5] 只取到前半截，
      // 金额会被静默当成 1 而不是 1000。必须拦下，不能"多出来的列不管"。
      while (c.length > 6 && String(c[c.length - 1]).trim() === '') c.pop() // 容忍行尾多余逗号
      if (c.length > 6) {
        bad.push(`第 ${line} 行有 ${c.length} 列，应为 6 列（多半是某字段含逗号却没加双引号，例如 1,000 要写成 "1,000"）`)
      }
      const qtyRaw = String(c[4] == null ? '' : c[4]).trim()
      const priceRaw = String(c[5] == null ? '' : c[5]).trim()
      const r = {
        line,
        warehouse: String(c[0] || '').trim(),
        no: String(c[1] || '').trim(),
        name: String(c[2] || '').trim(),
        spec: String(c[3] || '').trim(),
        qty: qtyRaw === '' ? 0 : Number(qtyRaw),
        price: priceRaw === '' ? 0 : Number(priceRaw)
      }
      // 数量和单价必须能解析成非负数。填了「10件」「1,000」这类会让导入变成 NaN 静默成 0/异常。
      if (!Number.isFinite(r.qty) || r.qty < 0) bad.push(`${r.warehouse} ${r.no || r.name}：实盘数量「${qtyRaw}」不是有效数字`)
      if (!Number.isFinite(r.price) || r.price < 0) bad.push(`${r.warehouse} ${r.no || r.name}：期初单价「${priceRaw}」不是有效数字`)
      if (!r.warehouse) bad.push(`第 ${r.line} 行：仓库为空`)
      if (!r.no && !r.name) bad.push(`第 ${r.line} 行：编号和名称都为空`)
      return r
    })
  return { rows, bad }
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

  const parsed = parseCsv(file)
  if (parsed.bad.length) {
    console.log(`\n⚠️ CSV 有 ${parsed.bad.length} 处格式问题（本次未建任何单据）：`)
    parsed.bad.slice(0, 20).forEach((m) => console.log(`   - ${m}`))
    if (parsed.bad.length > 20) console.log(`   ……另有 ${parsed.bad.length - 20} 处`)
    console.log('   修正后再跑。\n')
    process.exit(1)
  }
  const rows = parsed.rows.filter((r) => r.qty > 0)
  console.log(`实盘行数（数量>0）：${rows.length}`)
  const DRY = process.argv.includes('--dry-run')
  if (DRY) console.log('（演练模式：只匹配核对，不实际建单）')

  // 匹配物料 + 按仓聚合
  // ⚠️ 这里必须用 filter 判「命中几个」，**不能再用 find 取第一个**。
  //    2026-10-20 实测生产库 B003-58 同时对应「波纹管螺母」和「不锈钢托条」，
  //    用 find 时第二行的实盘数量会被静默记到第一个命中的物料头上 —— 不报错、不进 unmatched、
  //    单据照样提交成功，最后账是错的。这类错比对不上更难发现。
  const byWarehouse = {}
  const unmatched = []
  const ambiguous = []
  const badWarehouse = []
  const seenMaterial = new Map() // material_id -> 首次出现的行号
  const duplicated = []
  for (const r of rows) {
    const wid = whIdByName[r.warehouse]
    if (wid === undefined) { badWarehouse.push(r); continue }
    const hits = mats.filter((m) => {
      if (String(m.warehouse_id) !== String(wid)) return false
      if (r.no) return String(m.material_no || '') === r.no
      return String(m.name) === r.name && String(m.spec || '') === r.spec
    })
    if (!hits.length) { unmatched.push(r); continue }
    if (hits.length > 1) { ambiguous.push({ r, hits }); continue }
    const mat = hits[0]
    const mid = String(mat._id || mat.id)
    if (seenMaterial.has(mid)) { duplicated.push({ line: r.line, prevLine: seenMaterial.get(mid), name: mat.name }); continue }
    seenMaterial.set(mid, r.line)
    if (!byWarehouse[wid]) byWarehouse[wid] = []
    byWarehouse[wid].push({ material_id: mid, quantity: r.qty, unit_price: r.price, name: mat.name })
  }

  // ---- 只要有一行对不上就整体中止（全有或全无），绝不"能导多少导多少" ----
  let problem = 0
  if (badWarehouse.length) {
    problem += badWarehouse.length
    console.log(`\n⚠️ ${badWarehouse.length} 行的「仓库」在系统里不存在：`)
    badWarehouse.slice(0, 10).forEach((r) => console.log(`   - 第 ${r.line} 行：仓库「${r.warehouse}」（现有：${Object.keys(whIdByName).join(' / ')}）`))
  }
  if (ambiguous.length) {
    problem += ambiguous.length
    console.log(`\n⚠️ ${ambiguous.length} 行匹配到多个物料，不知道该记给谁（最危险的一类，会记错账）：`)
    ambiguous.slice(0, 10).forEach(({ r, hits }) => {
      console.log(`   - 第 ${r.line} 行  ${r.warehouse} ${r.no || r.name} → 命中 ${hits.length} 个：`)
      hits.forEach((h) => console.log(`       #${h.id} ${h.name} ${h.spec || ''}`))
    })
    console.log('   → 先给这些物料分配唯一编号，或在 CSV 里改用「名称+规格」区分。')
  }
  if (duplicated.length) {
    problem += duplicated.length
    console.log(`\n⚠️ ${duplicated.length} 行重复指向同一物料（同一料填了两行，数量会叠加，容易重复计数）：`)
    duplicated.slice(0, 10).forEach((d) => console.log(`   - 第 ${d.line} 行与第 ${d.prevLine} 行都是「${d.name}」`))
  }
  if (unmatched.length) {
    problem += unmatched.length
    console.log(`\n⚠️ ${unmatched.length} 行没匹配到物料（请先核对编号/名称/规格/仓库）：`)
    unmatched.slice(0, 20).forEach((r) => console.log(`   - 第 ${r.line} 行  ${r.warehouse} ${r.no || r.name} ${r.spec}`))
  }
  if (problem) {
    console.log(`\n   合计 ${problem} 处问题，修正后再跑。本次未建任何单据。\n`)
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
// 只在直接执行时跑 main；被 require 时只导出解析函数（供 tests 单测，不连库、不建单）
if (require.main === module) {
  main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
}
module.exports = { parseCsv }
