#!/usr/bin/env node
/**
 * 结构漂移自检：比对「当前连接的数据库」与 `src/db/schema.sql`
 * ============================================================
 * 为什么需要它（2026-10-16 事故）：
 *   生产库是早期结构，`outbound_orders.status` 只有 4 个值、且缺 7 个列，
 *   而代码早已按 4 态流程写 `picking` / `receiving` / `completed`
 *   → MySQL 抛 `Data truncated for column 'status' at row 1`
 *   → 出库「确认/拣货/收货」全流程在生产直接报错，直到真机实操才暴露。
 *
 *   这类「库落后于代码」的问题，代码 review、单元测试、接口冒烟**都发现不了**
 *   （dev 库是自己建的、结构是新的），只有真人点下去才会炸。
 *   → 每次部署前跑一次本脚本，就能提前拦住。
 *
 * 用法：
 *   cd server && node scripts/check-schema-drift.js
 *   → 退出码 0=对齐；1=有漂移（可挂到部署流程里当门禁）
 *
 * 判据：
 *   ✗ 错误（会让功能炸）：库缺表 / 库缺列 / 列类型不一致
 *   ? 提示（不阻塞）    ：库多出的列或表（多半是历史遗留或 _bak 备份表）
 * ============================================================
 */
require('../src/config/env')

const fs = require('fs')
const path = require('path')
const { pool } = require('../src/db/pool')

const SCHEMA_FILE = path.join(__dirname, '..', 'src', 'db', 'schema.sql')

/** 归一化列类型，屏蔽写法差异（INT(11)/INTEGER/空格/大小写） */
function normType(t) {
  return String(t)
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/INTEGER/g, 'INT')
    .replace(/INT\(\d+\)/g, 'INT')
    .replace(/BIGINT\(20\)/g, 'BIGINT')
}

/** 解析 schema.sql → { 表名: { 列名: 归一化类型 } } */
function parseSchemaSql(sql) {
  const tables = {}
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?([A-Za-z0-9_]+)`?\s*\(([\s\S]*?)\n\)/g
  let m
  while ((m = re.exec(sql))) {
    const [, table, body] = m
    const cols = {}
    for (const raw of body.split('\n')) {
      const line = raw.trim().replace(/,$/, '')
      const cm = line.match(/^`([A-Za-z0-9_]+)`\s+([A-Za-z]+(?:\([^)]*\))?(?:\s+UNSIGNED)?)/)
      if (!cm) continue
      cols[cm[1]] = normType(cm[2])
    }
    tables[table] = cols
  }
  return tables
}

/**
 * 执行自检，返回结构化结果（供 preflight 复用；不打印、不退出、不关连接池）
 * @returns {Promise<{dbName:string, schemaTables:number, liveTables:number, errors:string[], notes:string[]}>}
 */
async function run() {
  if (!fs.existsSync(SCHEMA_FILE)) {
    throw new Error(`找不到 schema 文件：${SCHEMA_FILE}`)
  }
  const expect = parseSchemaSql(fs.readFileSync(SCHEMA_FILE, 'utf8'))
  const expectTables = Object.keys(expect)

  const [rows] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION`
  )

  const live = {}
  for (const r of rows) {
    ;(live[r.TABLE_NAME] = live[r.TABLE_NAME] || {})[r.COLUMN_NAME] = normType(r.COLUMN_TYPE)
  }

  const isBackup = (t) => /^_bak/i.test(t)
  const errors = []
  const notes = []

  // 1) 缺表
  for (const t of expectTables) {
    if (!live[t]) errors.push(`缺表：${t}`)
  }

  // 2) 缺列 / 类型不一致
  for (const t of expectTables) {
    if (!live[t]) continue
    for (const [col, type] of Object.entries(expect[t])) {
      if (!(col in live[t])) {
        errors.push(`缺列：${t}.${col}（schema.sql 期望 ${type}）`)
      } else if (live[t][col] !== type) {
        errors.push(`类型不一致：${t}.${col}\n      库    = ${live[t][col]}\n      schema= ${type}`)
      }
    }
  }

  // 3) 库多出来的（提示，不阻塞）
  for (const t of Object.keys(live)) {
    if (isBackup(t)) continue
    if (!expect[t]) {
      notes.push(`库多出的表：${t}`)
      continue
    }
    for (const col of Object.keys(live[t])) {
      if (!(col in expect[t])) notes.push(`库多出的列：${t}.${col}（${live[t][col]}）`)
    }
  }

  const dbName = (await pool.query('SELECT DATABASE() AS d'))[0][0].d

  return {
    dbName,
    schemaTables: expectTables.length,
    liveTables: Object.keys(live).filter((t) => !isBackup(t)).length,
    errors,
    notes
  }
}

/** 打印报告（仅 CLI 使用；preflight 请直接用 run() 拿结构化结果） */
function printReport(r) {
  console.log('==============================================')
  console.log('  结构漂移自检：schema.sql  ⇄  当前数据库')
  console.log(`  数据库：${r.dbName}`)
  console.log(`  表数：schema.sql ${r.schemaTables} / 库 ${r.liveTables}（不含 _bak）`)
  console.log('==============================================\n')

  if (!r.errors.length) {
    console.log('✅ 无漂移：库结构与 schema.sql 一致\n')
  } else {
    console.log(`❌ 发现 ${r.errors.length} 处漂移（会导致功能报错，必须处理）：\n`)
    r.errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`))
    console.log('')
  }

  if (r.notes.length) {
    console.log(`ℹ️  ${r.notes.length} 处提示（不阻塞，多半是历史遗留）：`)
    r.notes.forEach((n) => console.log(`     · ${n}`))
    console.log('')
  }
}

module.exports = { run }

if (require.main === module) {
  main()
}

async function main() {
  try {
    const r = await run()
    printReport(r)
    await pool.end()
    process.exit(r.errors.length ? 1 : 0)
  } catch (err) {
    console.error('\n❌ 自检本身失败：', (err && err.message) || err)
    try {
      await pool.end()
    } catch (e) {
      /* 连接可能已断，忽略 */
    }
    process.exit(2)
  }
}
