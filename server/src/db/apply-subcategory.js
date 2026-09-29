/**
 * ============================================================
 * 细分类（sub_category）落地脚本
 * ------------------------------------------------------------
 * 背景：
 *   两个仓库的物料要再细分一层 ——
 *     · 成品仓 → 按「车间」分
 *     · 配件仓 → 按「编号」分
 *
 *   成品仓的原始数据里天然带着车间分组标题行
 *   （节能炉车间 / 工程车间 / 西厨车间），所以直接按它归类：
 *   标题行下面的产品，就属于这个车间。
 *
 *   配件仓的原始表里没有编号信息（当初转 JSON 时丢了），
 *   需要客户重新提供带编号列的表格后才好归类，本脚本暂不处理。
 *
 * 做什么：
 *   1. 确保 materials.sub_category 字段与索引存在（幂等）
 *   2. 成品仓：标题行下面的产品 → sub_category = 车间名
 *   3. 把分组标题行本身隐藏（is_deleted = 1）—— 它们是标题不是物料
 *
 * 用法：cd server && npm run apply:subcategory
 * 幂等：可重复执行，结果一致
 * ============================================================
 */
require('../config/env')

const { pool, query, queryOne, execute } = require('./pool')

/** 分组标题行的识别规则：名称以「车间」结尾（如「节能炉车间」） */
const GROUP_HEADER_RE = /车间$/

/** 1. 字段存在性（幂等） */
async function ensureColumn() {
  const col = await queryOne(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'materials'
        AND COLUMN_NAME = 'sub_category'`
  )
  if (col) {
    console.log('[字段] sub_category 已存在，跳过')
    return
  }
  await execute(
    `ALTER TABLE materials
       ADD COLUMN sub_category VARCHAR(64) NOT NULL DEFAULT ''
       COMMENT '细分类（成品仓=车间，配件仓=编号类目）' AFTER category`
  )
  console.log('[字段] 已新增 sub_category')
}

/** 2. 索引存在性（幂等） */
async function ensureIndex() {
  const idx = await queryOne(
    `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'materials'
        AND INDEX_NAME = 'idx_mat_sub_category'`
  )
  if (idx) {
    console.log('[索引] idx_mat_sub_category 已存在，跳过')
    return
  }
  await execute(
    'ALTER TABLE materials ADD KEY idx_mat_sub_category (warehouse_id, sub_category, is_deleted)'
  )
  console.log('[索引] 已新增 idx_mat_sub_category')
}

/**
 * 3. 成品仓按车间归类
 * 注意：这里故意不过滤 is_deleted —— 标题行虽然被隐藏了，
 *       但仍是分组依据，过滤掉就没法重复执行（幂等会坏）。
 */
async function applyChengpin() {
  const wh = await queryOne(
    "SELECT id, name FROM warehouses WHERE code = 'chengpin' AND is_deleted = 0 LIMIT 1"
  )
  if (!wh) throw new Error('找不到成品仓（code=chengpin），请先执行 npm run db:seed')

  // id 升序 = 原始表顺序，标题行靠这个顺序决定它管到哪
  const rows = await query(
    'SELECT id, name, sub_category, is_deleted FROM materials WHERE warehouse_id = ? ORDER BY id',
    [wh.id]
  )

  let current = ''
  const headers = []
  const updates = []

  for (const r of rows) {
    const name = String(r.name || '').trim()
    if (GROUP_HEADER_RE.test(name)) {
      current = name
      headers.push({ id: r.id, name })
      continue
    }
    if (current) updates.push({ id: r.id, sub_category: current, current: r.sub_category })
  }

  if (!headers.length) {
    console.log('[成品仓] 没找到车间标题行，跳过')
    return { headers: [], changed: 0, total: 0 }
  }

  console.log('[成品仓] 识别到车间分组：')
  for (const h of headers) {
    const cnt = updates.filter((u) => u.sub_category === h.name).length
    console.log(`   ${h.name}  →  ${cnt} 条产品`)
  }

  // 只更新真正有变化的行
  let changed = 0
  for (const u of updates) {
    if (u.current === u.sub_category) continue
    const r = await execute(
      'UPDATE materials SET sub_category = ? WHERE id = ?',
      [u.sub_category, u.id]
    )
    if (r.affectedRows) changed++
  }
  console.log(`[成品仓] 归类完成：本次更新 ${changed} 条（产品共 ${updates.length} 条）`)

  // 隐藏分组标题行
  let hidden = 0
  for (const h of headers) {
    const r = await execute(
      'UPDATE materials SET is_deleted = 1 WHERE id = ? AND is_deleted = 0',
      [h.id]
    )
    if (r.affectedRows) hidden++
  }
  const list = headers.map((h) => `${h.id}(${h.name})`).join('、')
  console.log(
    hidden
      ? `[标题行] 已隐藏 ${hidden} 条：${list}`
      : `[标题行] 此前已隐藏，跳过（${list}）`
  )

  return { headers, changed, total: updates.length }
}

/** 4. 配件仓现状提示 */
async function reportPeijian() {
  const wh = await queryOne(
    "SELECT id FROM warehouses WHERE code = 'peijian' AND is_deleted = 0 LIMIT 1"
  )
  if (!wh) return
  const c = await queryOne(
    "SELECT COUNT(*) AS c FROM materials WHERE warehouse_id = ? AND is_deleted = 0 AND sub_category = ''",
    [wh.id]
  )
  console.log(`[配件仓] 还有 ${c.c} 条未细分 —— 等带「编号」列的原始表到位后再补`)
}

async function main() {
  console.log('==============================================')
  console.log('  胜龙进销存 · 物料细分类落地')
  console.log('==============================================')

  await ensureColumn()
  await ensureIndex()

  const res = await applyChengpin()
  await reportPeijian()

  // 结果核对
  const sum = await query(
    `SELECT w.name AS warehouse_name, m.sub_category, COUNT(*) AS c
       FROM materials m
       LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.is_deleted = 0
      GROUP BY w.name, m.sub_category
      ORDER BY w.name, c DESC`
  )
  console.log('\n----------------------------------------------')
  console.log('  当前细分类分布')
  console.log('----------------------------------------------')
  for (const r of sum) {
    const label = r.sub_category || '（未细分）'
    console.log(`  ${String(r.warehouse_name).padEnd(6)} | ${label.padEnd(14)} | ${r.c} 条`)
  }

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
