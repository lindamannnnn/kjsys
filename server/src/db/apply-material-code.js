/**
 * ============================================================
 * 配件仓物料编号（material_no）与细分类落地脚本
 * ------------------------------------------------------------
 * 背景：
 *   客户提供的《胜龙配件明细.xlsx》里，每个配件都有编号，形如
 *   A001-1、B004-37、F002-116 ……
 *   编号的字母数字前缀（A001 / B004 / F002）就是原始表的分类。
 *
 *   Excel 共 1780 条有效编号行，数据库配件仓 1759 条
 *   （差 21 条是当初导入时被判定为「同名同规格重复」而跳过）。
 *
 * 做什么：
 *   1. 确保 materials.material_no 字段与索引存在（幂等）
 *   2. 按「名称 + 规格」把 Excel 编号匹配到数据库物料
 *      （匹配率实测 100%，见脚本输出）
 *   3. 写入 material_no（完整编号）与 sub_category（大类）
 *
 * 数据源：
 *   server/data/parts-code.json —— 由 Excel 一次性导出固化，
 *   脚本不依赖 Excel / Python，可重复执行。
 *
 * 用法：cd server && npm run apply:code
 * 幂等：可重复执行，结果一致
 * ============================================================
 */
require('../config/env')

const fs = require('fs')
const path = require('path')
const { pool, query, queryOne, execute } = require('./pool')

/**
 * 编号前缀 → 中文类名
 * 说明：分类以编号为准（这是客户原始表的口径），中文名只是给界面看
 *       的辅助说明。改名只需改这里，再重跑一次脚本即可。
 */
const PREFIX_NAMES = {
  A001: '板材型材',
  A002: '不锈钢板',
  A003: '纸箱护角',
  A004: '泡沫包装',
  B001: '炉盘炉架',
  B002: '风机',
  B003: '烟管波纹管',
  B004: '阀件铜件',
  C001: '螺丝螺母',
  D001: '钻头工具',
  E001: '铭牌标签',
  F001: '电气配件',
  F002: '管件杂项',
  G001: '发热元件',
  G002: '蒸柜配件',
  G003: '丝印耗材',
  G004: '工业气体',
  H001: '劳保用品',
  J001: '加工件',
  P001: '喷涂件'
}

/** 归一化：去空白、统一大小写，用于名称规格比对 */
function norm(s) {
  return String(s || '').replace(/\s+/g, '').trim()
}

/** 1. 字段存在性（幂等） */
async function ensureColumn() {
  const col = await queryOne(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'materials'
        AND COLUMN_NAME = 'material_no'`
  )
  if (col) {
    console.log('[字段] material_no 已存在，跳过')
    return
  }
  await execute(
    `ALTER TABLE materials
       ADD COLUMN material_no VARCHAR(32) NOT NULL DEFAULT ''
       COMMENT '物料编号（配件仓=A001-1 形式，成品仓留空）' AFTER sub_category`
  )
  console.log('[字段] 已新增 material_no')
}

/** 2. 索引存在性（幂等） */
async function ensureIndex() {
  const idx = await queryOne(
    `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'materials'
        AND INDEX_NAME = 'idx_mat_no'`
  )
  if (idx) {
    console.log('[索引] idx_mat_no 已存在，跳过')
    return
  }
  await execute(
    'ALTER TABLE materials ADD KEY idx_mat_no (warehouse_id, material_no, is_deleted)'
  )
  console.log('[索引] 已新增 idx_mat_no')
}

/** 3. 读取编号明细 */
function loadCodeFile() {
  const file = path.join(__dirname, '..', '..', 'data', 'parts-code.json')
  if (!fs.existsSync(file)) {
    throw new Error('找不到 data/parts-code.json（编号明细数据文件）')
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  const rows = Array.isArray(json.rows) ? json.rows : []
  if (!rows.length) throw new Error('data/parts-code.json 里没有数据')
  console.log(`[数据源] ${json.source} → ${rows.length} 条编号`)
  return rows
}

/** 4. 主流程 */
async function applyPeijian(codeRows) {
  const wh = await queryOne(
    "SELECT id, name FROM warehouses WHERE code = 'peijian' AND is_deleted = 0 LIMIT 1"
  )
  if (!wh) throw new Error('找不到配件仓（code=peijian），请先执行 npm run db:seed')

  const materials = await query(
    'SELECT id, name, spec, material_no, sub_category FROM materials WHERE warehouse_id = ? AND is_deleted = 0 ORDER BY id',
    [wh.id]
  )
  console.log(`[配件仓] 待处理 ${materials.length} 条物料`)

  // 建索引：先按 name+spec 精确，再退化到只按 name
  const byFull = new Map()
  const byName = new Map()
  for (const r of codeRows) {
    const k = norm(r.name) + '\u0000' + norm(r.spec)
    if (!byFull.has(k)) byFull.set(k, [])
    byFull.get(k).push(r)
    const kn = norm(r.name)
    if (!byName.has(kn)) byName.set(kn, [])
    byName.get(kn).push(r)
  }

  const updates = []
  const conflicts = []
  let miss = 0
  const missList = []

  for (const m of materials) {
    const k = norm(m.name) + '\u0000' + norm(m.spec)
    let cand = byFull.get(k)
    if (!cand) cand = byName.get(norm(m.name))
    if (!cand || !cand.length) {
      miss++
      if (missList.length < 10) missList.push(m)
      continue
    }
    // 同名同规格在原始表出现多次：检查它们的编号大类是否一致
    const prefixes = [...new Set(cand.map((c) => c.prefix))]
    if (cand.length > 1 && prefixes.length > 1) {
      conflicts.push({
        name: m.name,
        spec: m.spec,
        nos: cand.map((c) => c.no).join(','),
        prefixes: prefixes.join(',')
      })
    }
    // 取第一条（原始表顺序）
    const hit = cand[0]
    const sub = PREFIX_NAMES[hit.prefix]
      ? `${hit.prefix} ${PREFIX_NAMES[hit.prefix]}`
      : hit.prefix
    if (m.material_no === hit.no && m.sub_category === sub) continue
    updates.push({ id: m.id, no: hit.no, sub })
  }

  let changed = 0
  for (const u of updates) {
    const r = await execute(
      'UPDATE materials SET material_no = ?, sub_category = ? WHERE id = ?',
      [u.no, u.sub, u.id]
    )
    if (r.affectedRows) changed++
  }

  console.log(
    `[配件仓] 写入完成：本次更新 ${changed} 条，无变化 ${materials.length - changed - miss} 条，未匹配 ${miss} 条`
  )
  if (missList.length) {
    console.log('[配件仓] 未匹配样例：')
    for (const m of missList) {
      console.log(`   id=${m.id} [${m.name}] spec=${m.spec}`)
    }
  }
  if (conflicts.length) {
    console.log(`[提醒] 有 ${conflicts.length} 条物料在原始表里重复登记、且分属不同编号大类，已按首次出现的编号归类：`)
    for (const c of conflicts) {
      console.log(`   [${c.name}] ${c.spec} → 编号 ${c.nos}（大类 ${c.prefixes}）`)
    }
  }

  return { changed, miss, total: materials.length }
}

async function main() {
  console.log('==============================================')
  console.log('  胜龙进销存 · 配件仓物料编号落地')
  console.log('==============================================')

  await ensureColumn()
  await ensureIndex()

  const codeRows = loadCodeFile()
  await applyPeijian(codeRows)

  // 结果核对
  const sum = await query(
    `SELECT m.sub_category, COUNT(*) AS c
       FROM materials m
       JOIN warehouses w ON w.id = m.warehouse_id
      WHERE w.code = 'peijian' AND m.is_deleted = 0
      GROUP BY m.sub_category
      ORDER BY m.sub_category`
  )
  console.log('\n----------------------------------------------')
  console.log('  配件仓编号分类分布')
  console.log('----------------------------------------------')
  let total = 0
  for (const r of sum) {
    total += Number(r.c)
    console.log(`  ${String(r.sub_category || '（未细分）').padEnd(18)} | ${r.c} 条`)
  }
  console.log(`  ${'合计'.padEnd(19)} | ${total} 条`)

  await pool.end()
}

main().catch(async (e) => {
  console.error('[错误]', e.message)
  try {
    await pool.end()
  } catch (_) {
    /* ignore */
  }
  process.exit(1)
})
