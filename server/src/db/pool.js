/**
 * MySQL 连接池与事务辅助
 */
// 必须在读取 process.env 之前加载（与启动目录无关地定位 server/.env）
require('../config/env')

const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'shenglong',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'shenglong',

  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',

  // 时区：数据库按北京时间读写，转成 JS Date 后 JSON 输出为标准 ISO 串，
  // 与云开发返回格式一致，前端 new Date() 可正常解析
  timezone: '+08:00',

  // DECIMAL 直接返回 JS number（进销存大量金额/数量计算，避免字符串拼接出错）
  decimalNumbers: true,

  supportBigNumbers: true,
  bigNumberStrings: false,
  multipleStatements: false,
  namedPlaceholders: false
})

/**
 * 事务包装：回调内的所有操作在同一事务中，抛错自动回滚
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<any>} fn
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    try {
      await conn.rollback()
    } catch (rollbackErr) {
      console.error('[事务回滚失败]', rollbackErr.message)
    }
    throw err
  } finally {
    conn.release()
  }
}

/** 查询多行 */
async function query(sql, params = [], conn = null) {
  const runner = conn || pool
  const [rows] = await runner.query(sql, params)
  return rows
}

/** 查询单行 */
async function queryOne(sql, params = [], conn = null) {
  const rows = await query(sql, params, conn)
  return rows.length ? rows[0] : null
}

/** 执行写操作，返回 { insertId, affectedRows } */
async function execute(sql, params = [], conn = null) {
  const runner = conn || pool
  const [result] = await runner.query(sql, params)
  return result
}

/** 检测数据库连通性 */
async function ping() {
  const conn = await pool.getConnection()
  try {
    await conn.ping()
    return true
  } finally {
    conn.release()
  }
}

module.exports = { pool, withTransaction, query, queryOne, execute, ping }
