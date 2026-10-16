#!/usr/bin/env node
'use strict'
/**
 * 代码 ⇄ 数据库 「表.列」引用审计
 * ============================================================
 * 与 check-schema-drift.js 的分工（两者互补，缺一不可）：
 *   check-schema-drift.js ：schema.sql ⇄ 库   → 抓「库落后于 schema.sql」
 *   check-code-schema.js  ：代码实写的列 ⇄ 库 → 抓「schema.sql 自己也漏了」
 *
 * 为什么必须有第二个（2026-10-16 二次事故）：
 *   purchase_task_items.channel_remark 这一列，**schema.sql 和库两边都没有**，
 *   漂移检测于是报「无漂移」；但代码里那条 UPDATE 一到生产就
 *   ER_BAD_FIELD_ERROR → 采购录价 100% 失败，「录入采购信息」整条线断掉。
 *   判据只能是：**代码里真正写的「表.列」 ⇄ 库里真实存在的**。
 *
 * 检查范围：
 *   ① INSERT INTO t (a, b) / UPDATE t SET a=?        → 精确（缺了必 500）
 *   ② 表别名.列（FROM t a WHERE a.col=?）            → 精确
 *   ③ 单表 SQL 里的裸列名                            → 启发式（仅提示）
 *
 * 用法：
 *   cd server && node scripts/check-code-schema.js
 *   cd server && node scripts/check-code-schema.js --json
 *   # 指向其它库（上生产前用隧道连生产库跑；注意 dotenv 不会覆盖已设的环境变量）
 *   DB_HOST=127.0.0.1 DB_PORT=13306 DB_USER=root DB_PASSWORD=*** DB_NAME=shenglong \
 *     node scripts/check-code-schema.js
 *
 * 退出码：0=干净；1=发现「代码在用但库没有」；2=脚本自身失败
 * ============================================================
 */
const fs = require('fs')
const path = require('path')

require('../src/config/env')
const { pool } = require('../src/db/pool')

const SRC_DIR = path.join(__dirname, '..', 'src')

/** 非列名的 SQL 关键字 / 函数名，统一小写比对 */
const KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'as', 'on', 'join', 'left', 'right',
  'inner', 'outer', 'cross', 'group', 'by', 'order', 'limit', 'offset', 'insert', 'into', 'values', 'update',
  'set', 'delete', 'count', 'sum', 'case', 'when', 'then', 'else', 'end', 'desc', 'asc', 'distinct', 'if',
  'ifnull', 'coalesce', 'nullif', 'concat', 'now', 'true', 'false', 'cast', 'date', 'interval', 'between',
  'like', 'exists', 'having', 'union', 'all', 'any', 'add', 'column', 'table', 'default', 'primary', 'key',
  'auto_increment', 'unsigned', 'int', 'varchar', 'text', 'decimal', 'datetime', 'timestamp', 'bigint', 'tinyint',
  'json', 'enum', 'char', 'double', 'float', 'blob', 'replace', 'ignore', 'duplicate', 'for', 'with'
])

/** 从模板串 / 普通串里抠出疑似 SQL 片段 */
function extractSqlStrings(code) {
  const out = []
  const re = /`([^`]*)`|'((?:[^'\\]|\\.)*)'/g
  let m
  while ((m = re.exec(code))) {
    const s = m[1] !== undefined ? m[1] : m[2]
    if (!s || s.length < 12) continue
    if (/\b(select|insert\s+(?:ignore\s+)?into|update|delete\s+from)\b/i.test(s)) out.push(s)
  }
  return out
}

function walkJs(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walkJs(p, out)
    else if (f.endsWith('.js')) out.push(p)
  }
  return out
}

/** 读取库里真实的表 / 列结构 */
async function loadDbMeta() {
  const [cols] = await pool.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`
  )
  const [tbls] = await pool.query(
    `SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
  )
  const tables = new Set(tbls.map((r) => r.t))
  const byTable = {}
  const all = new Set()
  for (const r of cols) {
    ;(byTable[r.t] = byTable[r.t] || new Set()).add(r.c)
    all.add(r.c)
  }
  return { tables, byTable, all }
}

/**
 * 分析单个 SQL 片段
 * @returns {{refs: Array<{table:string,col:string}>, missingTable: string[], suspicious: Array<{col:string,kind:string}>}}
 */
function analyzeSql(sql, db) {
  const refs = []
  const missingTable = []
  const suspicious = []

  // ---------- ① INSERT INTO t (a, b, c) ----------
  for (const m of sql.matchAll(/insert\s+(?:ignore\s+)?into\s+`?(\w+)`?\s*\(([^)]*)\)/gi)) {
    const t = m[1]
    if (!db.tables.has(t)) {
      missingTable.push(t)
      continue
    }
    for (const raw of m[2].split(',')) {
      const c = raw.replace(/[`\s]/g, '')
      if (!c || /[()?]/.test(c)) continue
      refs.push({ table: t, col: c })
    }
  }

  // ---------- ② UPDATE t SET a = ?, b = ? ----------
  for (const m of sql.matchAll(/update\s+`?(\w+)`?\s+set\s+([\s\S]*?)(?:\bwhere\b|\border\b|\blimit\b|$)/gi)) {
    const t = m[1]
    if (!db.tables.has(t)) {
      missingTable.push(t)
      continue
    }
    for (const s of m[2].matchAll(/(?:^|,)\s*`?(\w+)`?\s*=/g)) {
      const c = s[1]
      if (!c || KEYWORDS.has(c.toLowerCase())) continue
      refs.push({ table: t, col: c })
    }
  }

  // ---------- 表别名映射：FROM/JOIN t alias | FROM/JOIN t AS alias ----------
  const aliasMap = {}
  for (const m of sql.matchAll(/\b(?:from|join)\s+`?(\w+)`?\s+(?:as\s+)?`?(\w+)`?/gi)) {
    const [, t, a] = m
    if (!db.tables.has(t)) continue
    if (KEYWORDS.has(a.toLowerCase())) continue
    aliasMap[a] = t
  }

  // ---------- ③ 别名.列 / 表名.列 ----------
  // ⚠️ 必须排除「紧跟左括号」的：JS 里的 materials.map(...) 会被误认成「表.列」（实测踩到）
  for (const m of sql.matchAll(/\b(\w+)\.`?(\w+)`?\b(?!\s*\()/g)) {
    const owner = m[1]
    const col = m[2]
    if (KEYWORDS.has(col.toLowerCase())) continue
    const t = db.tables.has(owner) ? owner : aliasMap[owner]
    if (!t) continue // 不是已知表/别名（多半是函数或 JSON 路径），跳过
    if (!db.byTable[t]) continue
    if (!db.byTable[t].has(col)) suspicious.push({ col, table: t, kind: '别名.列' })
  }

  // ---------- ④ 单表裸列（启发式，仅提示）----------
  const tableRefs = [...new Set([...sql.matchAll(/\b(?:from|join|update|into)\s+`?(\w+)`?/gi)].map((m) => m[1]))]
  // ⚠️ 含子查询的片段要跳过：如 PARTS_SCOPE_SQL
  //    `warehouse_id IN (SELECT id FROM warehouses WHERE ...)`
  //    这里的 FROM 属于子查询，裸列 warehouse_id 其实是**外层 purchase_tasks** 的，
  //    按「单表=warehouses」去套必然误报（实测踩到）。例外的代价远小于误报的代价。
  const hasSubquery = /\(\s*select\b/i.test(sql)
  if (!hasSubquery && tableRefs.length === 1 && db.tables.has(tableRefs[0])) {
    const t = tableRefs[0]
    // 去掉字符串常量与反引号，避免把数据当成列名
    const bare = sql.replace(/'(?:[^'\\]|\\.)*'/g, " '' ").replace(/`/g, '')
    const declared = new Set(
      [...sql.matchAll(/\bas\s+`?(\w+)`?/gi)].map((m) => m[1].toLowerCase())
    )
    for (const m of bare.matchAll(/(?:^|[\s,(=<>!+\-/*])([a-z_]\w{1,30})\b(?!\s*\()/gi)) {
      const id = m[1]
      const low = id.toLowerCase()
      if (KEYWORDS.has(low) || declared.has(low) || aliasMap[id]) continue
      if (db.all.has(id)) {
        // 列名在库中存在，但不在当前这张表 → 很有可能是写错了表
        if (!db.byTable[t].has(id)) {
          suspicious.push({ col: id, table: t, kind: '单表裸列' })
        }
      }
      // 库里任何表都没有的，噪太大（多为局部变量名），此处不报
    }
  }

  return { refs, missingTable, suspicious }
}

/** 主审计：返回结构化结果 */
async function run() {
  const db = await loadDbMeta()
  const files = walkJs(SRC_DIR)

  const refMap = new Map() // 表.列 → Set(位置)
  const missingTable = new Set()
  const suspicious = []
  const susSeen = new Set()

  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8')
    if (!/(select|insert|update)/i.test(code)) continue
    const where = f.replace(/\\/g, '/').split('/server/src/')[1] || f
    for (const sql of extractSqlStrings(code)) {
      const r = analyzeSql(sql, db)
      for (const t of r.missingTable) missingTable.add(`${t}  （${where}）`)
      for (const { table, col } of r.refs) {
        const k = `${table}.${col}`
        if (!refMap.has(k)) refMap.set(k, new Set())
        refMap.get(k).add(where)
      }
      for (const s of r.suspicious) {
        const k = `${s.table}.${s.col}.${s.kind}`
        if (susSeen.has(k)) continue
        susSeen.add(k)
        suspicious.push({ ...s, where })
      }
    }
  }

  // 精确缺失：表在库里，列不在
  const exact = []
  for (const [k, wheres] of refMap) {
    const i = k.indexOf('.')
    const t = k.slice(0, i)
    const c = k.slice(i + 1)
    if (!db.tables.has(t)) continue
    if (db.byTable[t] && !db.byTable[t].has(c)) {
      exact.push({ table: t, col: c, where: [...wheres].join(', ') })
    }
  }

  return {
    scannedFiles: files.length,
    dbTables: db.tables.size,
    dbCols: db.all.size,
    refs: refMap.size,
    exact,
    suspicious,
    missingTable: [...missingTable]
  }
}

async function main() {
  const json = process.argv.includes('--json')
  const dbName = (await pool.query('SELECT DATABASE() AS d'))[0][0].d
  const r = await run()

  if (json) {
    console.log(JSON.stringify({ db: dbName, ...r }, null, 2))
    await pool.end()
    process.exit(r.exact.length || r.missingTable.length ? 1 : 0)
  }

  console.log('==================================================')
  console.log('  代码 ⇄ 数据库  列引用审计')
  console.log(`  目标库：${dbName}`)
  console.log(`  扫描：${r.scannedFiles} 个源文件 · 库中 ${r.dbTables} 张表 ${r.dbCols} 个列`)
  console.log(`  提取到「表.列」引用：${r.refs} 处`)
  console.log('==================================================\n')

  if (r.missingTable.length) {
    console.log(`🔥 代码引用了但库中不存在的表（${r.missingTable.length}）：`)
    r.missingTable.forEach((x) => console.log(`     · ${x}`))
    console.log('')
  }

  if (r.exact.length) {
    console.log(`🔥 库缺失但代码在用的列（${r.exact.length} 处 —— 一旦点下去必然 500）：\n`)
    r.exact.forEach((e, i) => console.log(`  ${i + 1}. ${e.table}.${e.col}\n     代码位置：${e.where}`))
    console.log('')
  } else {
    console.log('✅ 代码里写到的每一列，库里都存在\n')
  }

  if (r.suspicious.length) {
    console.log(`⚠️  可疑（列名库里有，但不在这张表上 —— 需人工确认，${r.suspicious.length} 处）：`)
    r.suspicious.slice(0, 30).forEach((s) => console.log(`     · ${s.table}.${s.col}  [${s.kind}]  ${s.where}`))
    if (r.suspicious.length > 30) console.log(`     …… 其余 ${r.suspicious.length - 30} 处省略`)
    console.log('')
  }

  await pool.end()
  process.exit(r.exact.length || r.missingTable.length ? 1 : 0)
}

module.exports = { run }

if (require.main === module) {
  main().catch(async (e) => {
    console.error('\n❌ 审计脚本自身失败：', (e && e.message) || e)
    try {
      await pool.end()
    } catch (_) {
      /* 连接可能已断，忽略 */
    }
    process.exit(2)
  })
}
