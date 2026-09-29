/**
 * 数据库初始化：执行 schema.sql 建表
 * 用法：npm run db:init
 */
require('../config/env')

const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')

const CFG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'shenglong',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'shenglong'
}

async function main() {
  console.log('==============================================')
  console.log('  胜龙进销存 · 数据库建表')
  console.log(`  目标：${CFG.user}@${CFG.host}:${CFG.port}/${CFG.database}`)
  console.log('==============================================')

  const sqlPath = path.join(__dirname, 'schema.sql')
  if (!fs.existsSync(sqlPath)) {
    console.error(`[错误] 找不到建表脚本：${sqlPath}`)
    process.exit(1)
  }
  const sql = fs.readFileSync(sqlPath, 'utf8')

  let conn
  try {
    conn = await mysql.createConnection({ ...CFG, multipleStatements: true, charset: 'utf8mb4' })
  } catch (e) {
    console.error(`[错误] 无法连接数据库：${e.message}`)
    console.error('请确认 MySQL 已启动（docker compose up -d mysql），且 .env 配置正确')
    process.exit(1)
  }

  try {
    await conn.query(sql)
    console.log('[建表] schema.sql 执行完成')

    const [tables] = await conn.query('SHOW TABLES')
    const names = tables.map((t) => Object.values(t)[0])

    console.log(`[建表] 当前数据库共 ${names.length} 张表：`)
    for (const n of names) {
      const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM \`${n}\``)
      console.log(`   - ${n.padEnd(24)} ${String(rows[0].c).padStart(6)} 行`)
    }

    const expected = [
      'warehouses', 'users', 'materials', 'suppliers',
      'outbound_orders', 'outbound_order_items',
      'inbound_orders', 'inbound_order_items',
      'stock_checks', 'stock_check_items', 'stock_logs',
      'operation_logs', 'settings'
    ]
    const missing = expected.filter((t) => !names.includes(t))
    if (missing.length) {
      console.error(`[警告] 缺少表：${missing.join(', ')}`)
      process.exit(1)
    }

    console.log(`\n[完成] 13 张表全部就绪`)
    console.log('下一步：npm run db:seed')
  } catch (e) {
    console.error('[错误] 建表失败：', e.message)
    process.exit(1)
  } finally {
    await conn.end()
  }
}

main()
