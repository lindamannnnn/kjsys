/**
 * ============================================================
 * 期初建账批量录入（按 Excel 实盘表）
 * ------------------------------------------------------------
 * 用途：客户给一张实盘 Excel（仓库/编号/名称/规格/实盘数量/期初单价），
 *       一次把「缺的物料档案 + 期初数量」全录进系统。
 *
 * 为什么不用 init-stock.js：
 *   那个脚本走「生成期初入库单」路线，期初会被月结表算进「本月收入」；
 *   而这个脚本走 `material.setOpening`（change_type='opening'），
 *   期初与真实采购收入在流水层就能分开 —— 后者才是 2026-10-20 之后的口径。
 *
 * 三步：
 *   ① material.setOpeningMode { enabled: true }   开闸（后台开关，仅 admin/boss）
 *   ② 缺档案的逐条 material.upsert（名称+规格+仓库 唯一，重复会 409，视为已存在）
 *   ③ 数量 > 0 的逐条 material.setOpening { id, quantity, amount }
 *   ④ 无论成败，finally 里把开关关回去
 *
 * ⚠️ 三条硬约束：
 *   1) 与 init-stock.js 一样「全有或全无」——计划里任意一条匹配/创建失败就整体中止，
 *      绝不留半截账（已写进去的不会自动回滚，但会打印清单让人手工接着跑，
 *      setOpening 幂等，重跑安全）。
 *   2) **写之前必须断言目标物料 current_stock === 0**。
 *      期初建账只允许在「清 0 之后、正式启用那一刻」做一次；
 *      已经动过库存的物料再跑会变成「加权平均之外的凭空加数」，必须拦住。
 *   3) 金额不填 = 0 → 成本价 0，这是「先盘准数量、价格后补」的既定选择，
 *      不是 bug。补价要用 batch patch，不能用这个脚本重跑。
 *
 * 用法：
 *   API_BASE=https://sl.ekkosys.cn TOKEN=<admin令牌> \
 *   node scripts/opening-fill.js ../_opening_plan.json          # 预演
 *   API_BASE=... TOKEN=... APPLY=1 \
 *   node scripts/opening-fill.js ../_opening_plan.json          # 真写
 *
 * 计划文件格式见 _opening_plan.json：
 *   { warehouse_id, category, unit, warning_stock,
 *     create:  [{ name, spec, sub_category, qty }],
 *     opening: [{ id, name, spec, qty }] }
 * ============================================================ */
require('../src/config/env')

const fs = require('fs')
const path = require('path')

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000'
const TOKEN = process.env.TOKEN || ''
const APPLY = process.env.APPLY === '1'
const AMOUNT = Number(process.env.AMOUNT || 0) // 期初单价统一，默认 0

if (!TOKEN) {
  console.error('缺少 TOKEN（admin 令牌）。签发方式见文件头。')
  process.exit(1)
}

const planPath = path.resolve(process.argv[2] || '../_opening_plan.json')
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
const WH = Number(plan.warehouse_id || 2)

let okCount = 0
let failCount = 0
const failures = []

async function call(module, action, data = {}) {
  const res = await fetch(`${BASE}/api/${module}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action, data })
  })
  return res.json()
}

function line(s = '') {
  console.log(s)
}

/** 拉全量物料（成品仓），建「名称+规格」→ 物料 的索引 */
async function fetchAll() {
  const all = []
  let page = 1
  for (;;) {
    const r = await call('material', 'list', { warehouse_id: WH, page, pageSize: 200 })
    if (!r || r.code !== 0) throw new Error(`拉物料列表失败：${r && r.message}`)
    const d = r.data || {}
    const rows = d.list || d.items || d.rows || []
    all.push(...rows)
    if (rows.length < 200) break
    page += 1
    if (page > 50) break
  }
  return all
}

const key = (n, s) => `${String(n || '').trim()}||${String(s || '').trim()}`

async function main() {
  line(`接口：${BASE}`)
  line(`计划：${path.basename(planPath)}   仓库 ${WH}   模式 ${APPLY ? '★真写★' : '预演（不写库）'}`)
  line('')

  // ---------- 0. 现状 ----------
  const before = await fetchAll()
  line(`当前仓库物料 ${before.length} 条，其中有库存 ${before.filter((m) => Number(m.current_stock) > 0).length} 条`)
  const byKey = new Map()
  for (const m of before) {
    const k = key(m.name, m.spec)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(m)
  }

  const create = plan.create || []
  const opening = plan.opening || []

  // ---------- 1. 前置校验：能建的才能建，已有库存的一律拦 ----------
  const toCreate = []
  for (const c of create) {
    const hit = byKey.get(key(c.name, c.spec))
    if (hit && hit.length) {
      const m = hit[0]
      if (Number(m.current_stock) > 0) {
        failures.push(`「${c.name}」已存在且库存 ${m.current_stock}，拒绝重复建账`)
        continue
      }
      line(`  跳过建档（已存在 id=${m._id || m.id}）：${c.name}`)
      continue
    }
    toCreate.push(c)
  }

  const toOpen = []
  for (const o of opening) {
    const m = before.find((x) => Number(x._id || x.id) === Number(o.id))
    if (!m) {
      failures.push(`id=${o.id}「${o.name}」在库里不存在`)
      continue
    }
    if (Number(m.current_stock) > 0) {
      failures.push(`id=${o.id}「${o.name}」当前库存 ${m.current_stock}（≠0），期初建账只允许在清 0 后做一次`)
      continue
    }
    toOpen.push({ ...o, _name: m.name })
  }

  line('')
  line(`待建档 ${toCreate.length} 条 / 待建账（已有物料）${toOpen.length} 条`)

  if (failures.length) {
    line('')
    line('❌ 前置校验未通过，整体中止（一行都不写）：')
    for (const f of failures) line(`   · ${f}`)
    process.exit(1)
  }
  if (!APPLY) {
    line('')
    line('预演结束。确认无误后加 APPLY=1 再跑一次。')
    return
  }

  // ---------- 2. 开闸 ----------
  const mode = await call('material', 'getOpeningMode')
  line('')
  line(`期初建账开关：${mode.data && mode.data.enabled ? '已开启' : '关闭'} / 可编辑 ${mode.data && mode.data.canEdit}`)
  if (!(mode.data && mode.data.enabled)) {
    const on = await call('material', 'setOpeningMode', { enabled: true })
    if (!on || on.code !== 0) throw new Error(`开启期初建账失败：${on && on.message}`)
    line('已开启期初建账模式')
  }

  try {
    // ---------- 3. 建档 ----------
    for (const c of toCreate) {
      const r = await call('material', 'upsert', {
        name: c.name,
        spec: c.spec,
        category: plan.category || '成品',
        sub_category: c.sub_category || '',
        unit: c.unit || plan.unit || '台',
        warehouse_id: WH,
        warning_stock: plan.warning_stock === undefined ? 5 : plan.warning_stock
      })
      if (r && r.code === 0) {
        line(`  ＋建档 ${c.name}（${c.spec}）→ id=${(r.data && (r.data._id || r.data.id)) || '?'}`)
        okCount += 1
      } else if (r && r.code === 409) {
        line(`  ＝已存在（跳过）${c.name}`)
      } else {
        failures.push(`建档「${c.name}」失败：${r && r.message}`)
        failCount += 1
      }
    }

    if (failures.length) throw new Error('建档阶段有失败，不再继续建账')

    // ---------- 4. 重新拉一遍，把新档案的 id 解析出来 ----------
    const mid = await fetchAll()
    const idx = new Map()
    for (const m of mid) {
      const k = key(m.name, m.spec)
      if (!idx.has(k)) idx.set(k, m)
    }
    const openList = [...toOpen]
    for (const c of toCreate) {
      const m = idx.get(key(c.name, c.spec))
      if (!m) {
        failures.push(`刚建的「${c.name}」在列表里找不到（可能被判为重复）`)
        continue
      }
      if (Number(c.qty) > 0) {
        openList.push({ id: m._id || m.id, name: c.name, spec: c.spec, qty: c.qty })
      }
    }
    if (failures.length) throw new Error('id 解析失败，不再继续建账')

    // ---------- 5. 建账 ----------
    line('')
    line(`开始建账 ${openList.length} 条，合计 ${openList.reduce((s, x) => s + Number(x.qty), 0)}`)
    let done = 0
    for (const o of openList) {
      const qty = Number(o.qty)
      const amount = Number((qty * AMOUNT).toFixed(2))
      const r = await call('material', 'setOpening', { id: o.id, quantity: qty, amount })
      done += 1
      if (r && r.code === 0) {
        okCount += 1
        if (done % 10 === 0 || done === openList.length) line(`  进度 ${done}/${openList.length}`)
      } else {
        failCount += 1
        failures.push(`建账 id=${o.id}「${o.name}」x${qty} 失败：${r && r.message}`)
        line(`  ✗ id=${o.id} ${o.name} —— ${r && r.message}`)
      }
    }
  } finally {
    // ---------- 6. 关闸（一定关，失败也关） ----------
    const off = await call('material', 'setOpeningMode', { enabled: false })
    line('')
    line(off && off.code === 0 ? '已关闭期初建账模式' : `⚠️ 关闭期初建账失败：${off && off.message}`)
  }
}

main()
  .then(() => {
    line('')
    line('========== 汇总 ==========')
    line(`成功 ${okCount} 条，失败 ${failCount} 条`)
    if (failures.length) {
      line('失败明细：')
      for (const f of failures) line(`  · ${f}`)
      process.exitCode = 1
    } else {
      line('全部完成')
    }
  })
  .catch((e) => {
    line('')
    line(`❌ 中止：${e.message}`)
    for (const f of failures) line(`  · ${f}`)
    process.exit(1)
  })
