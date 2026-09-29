/**
 * 导入真实物料数据
 * 用法：npm run import:materials
 *
 * 数据来源优先级：
 *   1. 命令行参数指定的文件：node src/db/import-materials.js path/to/file.json
 *   2. 默认读取 ../../cloudfunctions/materials-init.json（从真实 Excel 转换而来）
 *
 * 支持 .json，以及 .xls/.xlsx（使用 xlsx 库解析）
 */
require('../config/env')

const fs = require('fs')
const path = require('path')
const { pool, queryOne, execute } = require('./pool')
const { resolveWarehouseId } = require('../services/warehouse')

const DEFAULT_JSON = path.resolve(__dirname, '../../../cloudfunctions/materials-init.json')

/** 从 Excel 读取（兜底能力，便于后续直接上传表格导入） */
function readExcel(filePath) {
  const XLSX = require('xlsx')
  const wb = XLSX.readFile(filePath)
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  return rows.map((r) => ({
    name: String(r['名称'] || r['物料名称'] || r['产品名称'] || r['品名'] || '').trim(),
    spec: String(r['规格'] || r['规格型号'] || r['型号'] || '').trim(),
    category: String(r['分类'] || r['类别'] || '').trim(),
    unit: String(r['单位'] || '个').trim(),
    warehouse_id: String(r['仓库'] || r['warehouse_id'] || 'peijian').trim(),
    current_stock: Number(r['库存'] || r['当前库存'] || 0) || 0,
    warning_stock: Number(r['预警库存'] || r['预警'] || 10) || 10
  }))
}

/** 读取数据文件 */
function loadData(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.json') {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.materials || raw.data || []
    return arr
  }
  if (ext === '.xls' || ext === '.xlsx') {
    return readExcel(filePath)
  }
  throw new Error(`不支持的文件类型：${ext}（请使用 .json / .xls / .xlsx）`)
}

async function main() {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_JSON

  console.log('==============================================')
  console.log('  胜龙进销存 · 导入真实物料数据')
  console.log(`  数据文件：${filePath}`)
  console.log('==============================================')

  if (!fs.existsSync(filePath)) {
    console.error(`[错误] 找不到数据文件：${filePath}`)
    console.error('可传入自定义路径：node src/db/import-materials.js <文件路径>')
    process.exit(1)
  }

  const raw = loadData(filePath)
  console.log(`[读取] 共 ${raw.length} 条记录`)

  // 仓库 code → id 缓存，避免每条都查库
  const whCache = new Map()
  async function whId(code) {
    const key = String(code || 'peijian')
    if (whCache.has(key)) return whCache.get(key)
    const id = await resolveWarehouseId(key)
    if (!id) throw new Error(`仓库不存在：${key}（请先执行 npm run db:seed）`)
    whCache.set(key, id)
    return id
  }

  let inserted = 0
  let skipped = 0
  let failed = 0
  const errors = []
  const startTime = Date.now()

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // 预加载已有物料（name|spec|warehouse_id），实现去重
    const [existingRows] = await conn.query(
      'SELECT name, spec, warehouse_id FROM materials WHERE is_deleted = 0'
    )
    const existing = new Set(
      existingRows.map((r) => `${r.name}|${r.spec}|${r.warehouse_id}`)
    )
    console.log(`[去重] 数据库中已有物料 ${existing.size} 条`)

    for (let i = 0; i < raw.length; i++) {
      const item = raw[i]
      try {
        const name = String(item.name || '').trim()
        if (!name) {
          failed++
          errors.push(`第 ${i + 1} 行：名称为空`)
          continue
        }

        const spec = String(item.spec || '').trim()
        const wid = await whId(item.warehouse_id)
        const key = `${name}|${spec}|${wid}`

        if (existing.has(key)) {
          skipped++
          continue
        }
        existing.add(key)

        await conn.query(
          `INSERT INTO materials
             (name, spec, category, unit, warehouse_id, current_stock, warning_stock,
              avg_cost, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NOW(), NOW())`,
          [
            name.slice(0, 191),
            spec.slice(0, 191),
            String(item.category || '').slice(0, 64),
            String(item.unit || '个').slice(0, 16),
            wid,
            Number(item.current_stock || 0),
            Number(item.warning_stock ?? 10)
          ]
        )
        inserted++
      } catch (e) {
        failed++
        errors.push(`第 ${i + 1} 行（${item.name}）：${e.message}`)
      }
    }

    await conn.commit()
  } catch (e) {
    await conn.rollback()
    console.error('[错误] 导入失败，已回滚：', e.message)
    conn.release()
    await pool.end()
    process.exit(1)
  } finally {
    if (conn) conn.release?.()
  }

  const cost = ((Date.now() - startTime) / 1000).toFixed(1)

  // ---------- 结果核对 ----------
  const byWh = await conn.query(
    `SELECT w.name AS warehouse, COUNT(*) AS c, COALESCE(SUM(m.current_stock),0) AS stock
       FROM materials m JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.is_deleted = 0 GROUP BY w.id, w.name ORDER BY w.id`
  ).then(([rows]) => rows).catch(() => [])

  console.log('\n----------------------------------------------')
  console.log(`新增：${inserted} 条`)
  console.log(`跳过（已存在）：${skipped} 条`)
  console.log(`失败：${failed} 条`)
  console.log(`耗时：${cost} 秒`)
  console.log('----------------------------------------------')
  console.log('各仓库物料数：')
  for (const r of byWh) {
    console.log(`   ${r.warehouse}：${r.c} 条，库存合计 ${r.stock}`)
  }

  if (errors.length) {
    console.log('\n失败明细（前 20 条）：')
    errors.slice(0, 20).forEach((e) => console.log(`   - ${e}`))
  }

  console.log('\n下一步：npm run verify')

  await pool.end()
}

main().catch((e) => {
  console.error('[错误]', e.message)
  process.exit(1)
})
