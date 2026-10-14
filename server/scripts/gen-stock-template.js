/**
 * 生成「期初库存导入模板.csv」—— 预填所有现有物料，实盘后只需填数量和单价。
 * 用法：node scripts/gen-stock-template.js [输出路径]
 * 默认输出到 ../../docs/期初库存导入模板.csv
 */
require('../src/config/env')
const fs = require('fs')
const path = require('path')
const { query } = require('../src/db/pool')

async function main() {
  const out = process.argv[2] || path.join(__dirname, '..', '..', 'docs', '期初库存导入模板.csv')
  const rows = await query(
    `SELECT w.name AS wh, m.material_no, m.name, m.spec, m.unit
     FROM materials m JOIN warehouses w ON w.id = m.warehouse_id
     WHERE m.is_deleted = 0 ORDER BY w.id, m.material_no, m.name`
  )
  const esc = (s) => {
    s = String(s == null ? '' : s)
    return /[",\n，]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const header = '仓库,编号,名称,规格,实盘数量,期初单价'
  const lines = rows.map((r) => [r.wh, r.material_no, r.name, r.spec, '', ''].map(esc).join(','))
  // 加 BOM，让 Excel 正确识别中文
  fs.writeFileSync(out, '﻿' + header + '\n' + lines.join('\n') + '\n', 'utf8')
  console.log(`✅ 模板已生成：${out}（${rows.length} 条物料）`)
  console.log('   实盘后只需填「实盘数量」和「期初单价」两列，另存为 CSV 后用 init-stock.js 导入。')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
