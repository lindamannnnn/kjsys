/**
 * 迁移：出库单 2 态 → 4 态（流程重构 V2 · P2 领料线）
 * ============================================================
 * 改了什么：
 *   1. status 枚举扩展：pending / picking / receiving / completed
 *      （confirmed 作为历史遗留值保留在枚举里，避免 ALTER 时丢数据；
 *        数据部分会把它统一转成 completed）
 *   2. 新增字段：
 *      pick_operator_openid / pick_operator_name / picked_at
 *      receive_operator_openid / receive_operator_name / received_at
 *      stock_deducted（是否已扣过库存，驳回/作废据此决定要不要回补）
 *   3. 历史数据（关键，不能漏）：
 *      老流程在「提交」那一刻就扣了库存，所以迁移前已存在的单据，
 *      只要没被驳回/作废，库存其实都已经扣过了 → 一律标记 stock_deducted=1：
 *        · confirmed（已确认生效）→ completed + stock_deducted=1
 *        · pending  （还没确认，但库存已扣）→ 保持 pending + stock_deducted=1
 *      这样它们走到「确认收货」时不会再扣一次（receive 会看这个标记），
 *      被驳回/作废时也能正确回补。
 *      rejected / cancelled 保持 stock_deducted=0（老流程当时已回补过）。
 *
 * ⚠️ 数据段默认**不执行**（2026-10-16 加固）：
 *   下面【3】的历史数据 UPDATE 只在「老流程（提交即扣库存）」的库上成立。
 *   若在**已经是新流程**的库上跑（出库提交不扣、收货才扣），
 *   会把待确认单的 stock_deducted 误标为 1 → 以后确认收货时库存**永远不扣**（静默数据错误）。
 *   所以改成显式开关：默认只做结构，真要处理历史数据得加 --with-legacy-data。
 *
 * 用法：
 *   npm run db:migrate-outbound                       # 预演（只读）
 *   npm run db:migrate-outbound -- --apply            # 只做结构（枚举 + 补列），推荐
 *   npm run db:migrate-outbound -- --apply --with-legacy-data
 *                                                     # ⚠️ 连历史数据一起改，仅限老流程的库
 *
 * 幂等：重复执行安全（列已存在则跳过，数据 UPDATE 只影响指定状态的单）。
 * ============================================================
 */
require('../config/env')

const { pool } = require('./pool')

const TABLE = 'outbound_orders'

/** 目标状态枚举（confirmed 保留，仅为兼容历史数据） */
const STATUS_ENUM = "ENUM('pending','picking','receiving','completed','confirmed','cancelled','rejected')"

const NEW_COLUMNS = [
  { name: 'pick_operator_openid', ddl: "VARCHAR(64) DEFAULT NULL COMMENT '拣货完成操作人' AFTER `confirmed_at`" },
  { name: 'pick_operator_name', ddl: "VARCHAR(64) DEFAULT NULL AFTER `pick_operator_openid`" },
  { name: 'picked_at', ddl: "DATETIME DEFAULT NULL COMMENT '拣货完成时间（此刻通知领料员来收货）' AFTER `pick_operator_name`" },
  { name: 'receive_operator_openid', ddl: "VARCHAR(64) DEFAULT NULL COMMENT '确认收货人' AFTER `picked_at`" },
  { name: 'receive_operator_name', ddl: "VARCHAR(64) DEFAULT NULL AFTER `receive_operator_openid`" },
  { name: 'received_at', ddl: "DATETIME DEFAULT NULL COMMENT '确认收货时间，库存在此刻扣减' AFTER `receive_operator_name`" },
  {
    name: 'stock_deducted',
    ddl: "TINYINT NOT NULL DEFAULT 0 COMMENT '库存是否已扣减：1=已扣，0=未扣；驳回/作废据此决定是否回补' AFTER `received_at`"
  }
]

async function columnInfo(column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [TABLE, column]
  )
  return rows[0] || null
}

async function tableExists() {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [TABLE])
  return rows.length > 0
}

async function main() {
  const apply = process.argv.includes('--apply')
  const withLegacyData = process.argv.includes('--with-legacy-data')

  console.log('==============================================')
  console.log('  迁移：出库单 2 态 → 4 态（领料线）')
  console.log(`  模式：${apply ? '★ 执行（写库）' : '预演（只读，不改任何数据）'}`)
  console.log(`  数据段：${withLegacyData ? '⚠️ 启用（会改历史单的 stock_deducted）' : '跳过（只做结构，默认）'}`)
  console.log('==============================================\n')

  if (!(await tableExists())) {
    console.error(`❌ 表 ${TABLE} 不存在，请先初始化数据库`)
    await pool.end()
    process.exit(1)
  }

  // ---------- 1. 检查 status 枚举 ----------
  const statusCol = await columnInfo('status')
  if (!statusCol) {
    console.error('❌ 未找到 status 列，表结构异常')
    await pool.end()
    process.exit(1)
  }
  const needEnum =
    !statusCol.COLUMN_TYPE.includes('picking') || !statusCol.COLUMN_TYPE.includes('receiving')

  console.log('【1】status 枚举')
  console.log(`   当前：${statusCol.COLUMN_TYPE}`)
  console.log(`   目标：${STATUS_ENUM}`)
  console.log(`   ${needEnum ? '→ 需要修改 ⚠️' : '→ 已是目标结构 ✓'}\n`)

  // ---------- 2. 检查新增列 ----------
  console.log('【2】新增字段')
  const missing = []
  for (const col of NEW_COLUMNS) {
    const info = await columnInfo(col.name)
    if (info) {
      console.log(`   ${col.name.padEnd(26)} 已存在 ✓`)
    } else {
      console.log(`   ${col.name.padEnd(26)} 缺失，将新增 ＋`)
      missing.push(col)
    }
  }
  console.log(`   合计需新增 ${missing.length} 列\n`)

  // ---------- 3. 历史数据处理 ----------
  // 老流程：提交时就扣库存 → 迁移前存在的单据（非驳回/作废）库存都已扣过
  const [statRows] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM \`${TABLE}\`
      WHERE status IN ('pending','confirmed')
      GROUP BY status`
  )
  const statMap = {}
  let legacyTotal = 0
  for (const r of statRows) {
    statMap[r.status] = Number(r.c)
    legacyTotal += Number(r.c)
  }
  const confirmedCount = statMap.confirmed || 0
  const pendingCount = statMap.pending || 0

  const [[allRow]] = await pool.query(`SELECT COUNT(*) AS c FROM \`${TABLE}\``)
  const totalCount = Number(allRow.c || 0)

  console.log('【3】历史数据')
  console.log(`   单据总数：${totalCount}`)
  console.log(`   当前 pending/confirmed 单：${legacyTotal} 张`)
  console.log(`     · confirmed → 转为 completed 并标记已扣：${confirmedCount} 张`)
  console.log(`     · pending   → 保持待确认，但标记已扣：${pendingCount} 张`)
  console.log(`   数据段本次：${withLegacyData ? '⚠️ 会执行（仅当这些单来自「提交即扣库存」的老流程才正确）' : '跳过（默认只做结构）'}`)
  console.log('   ⚠️ 判断依据：老流程=提交就扣库存 → 要标 1；新流程=收货才扣 → 必须保持 0。\n')

  if (!apply) {
    console.log('----------------------------------------------')
    console.log('预演结束，未改动任何数据。')
    console.log('只做结构：npm run db:migrate-outbound -- --apply')
    console.log('连数据改：npm run db:migrate-outbound -- --apply --with-legacy-data')
    console.log('----------------------------------------------')
    await pool.end()
    return
  }

  // ---------- 执行 ----------
  console.log('----------------------------------------------')
  console.log('开始执行…\n')

  if (needEnum) {
    await pool.query(
      `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`status\` ${STATUS_ENUM} NOT NULL DEFAULT 'pending'`
    )
    console.log('   ✓ status 枚举已扩展')
  } else {
    console.log('   · status 枚举无需修改')
  }

  for (const col of missing) {
    await pool.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN \`${col.name}\` ${col.ddl}`)
    console.log(`   ✓ 已新增列 ${col.name}`)
  }

  if (withLegacyData) {
    // 历史 confirmed 单：转 completed 并标记已扣库存
    const [upd1] = await pool.query(
      `UPDATE \`${TABLE}\`
          SET status = 'completed', stock_deducted = 1
        WHERE status = 'confirmed'`
    )
    console.log(`   ✓ 历史 confirmed 单已转为 completed，影响 ${upd1.affectedRows} 行`)

    // 历史 pending 单：库存其实已扣（老流程提交即扣），补标记，防止将来重复扣
    const [upd2] = await pool.query(
      `UPDATE \`${TABLE}\`
          SET stock_deducted = 1
        WHERE status = 'pending' AND stock_deducted = 0`
    )
    console.log(`   ✓ 历史 pending 单已标记为「库存已扣」，影响 ${upd2.affectedRows} 行`)
  } else {
    console.log('   · 数据段已跳过（默认）—— 结构已对齐，历史数据保持原样')
    if (legacyTotal > 0) {
      console.log(`     ⚠️ 但当前库里有 ${legacyTotal} 张 pending/confirmed 单。`)
      console.log('        若它们来自「老流程（提交即扣库存）」，需要用 --with-legacy-data 补 stock_deducted=1；')
      console.log('        若来自「新流程（收货才扣）」，跳过才是对的（当前就是这种情况）。')
    }
  }

  // ---------- 复核 ----------
  console.log('\n【复核】')
  const after = await columnInfo('status')
  console.log(`   status：${after.COLUMN_TYPE}`)
  for (const col of NEW_COLUMNS) {
    const info = await columnInfo(col.name)
    console.log(`   ${col.name.padEnd(26)} ${info ? '✓' : '✗'}`)
  }
  const [[stat]] = await pool.query(
    `SELECT
       SUM(status = 'confirmed') AS confirmed_left,
       SUM(status = 'completed') AS completed,
       SUM(status = 'pending')   AS pending
     FROM \`${TABLE}\``
  )
  console.log(`   数据：completed=${Number(stat.completed || 0)}  pending=${Number(stat.pending || 0)}  confirmed 残留=${Number(stat.confirmed_left || 0)}`)

  console.log('\n✅ 迁移完成。请重启服务后生效。')
  await pool.end()
}

main().catch(async (err) => {
  console.error('\n❌ 迁移失败：', err && err.message ? err.message : err)
  try {
    await pool.end()
  } catch (e) {
    /* 连接可能已断，忽略 */
  }
  process.exit(1)
})
