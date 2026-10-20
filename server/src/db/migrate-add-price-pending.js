/**
 * 迁移：入库明细支持「待补价」（2026-10-20）
 *
 * 背景：销售端还没接入，成品仓的上线初期没有价格数据。原来入库单价是必填且禁止 0
 *   （填 0 会把移动加权成本永久稀释），结果成品仓连入库都提交不了。
 *
 * 做法：允许 unit_price = NULL，用 price_pending 标记「这一项还没定价」。
 *   - NULL 不参与加权成本计算（avg_cost 保持不变），不会被当成 0 稀释
 *   - 单据上的 pending_count 冗余记「本单有几项待补」，列表页可直接筛
 *   - 补价走既有 inbound.updatePrice：把 NULL 改成数字，同时清标记
 *
 * 幂等：列已存在 / 已经是可空，则跳过。
 * 与 schema.sql 必须同步改，否则 `npm run db:check-schema` 会报结构漂移。
 */
require('../../src/config/env')
const { queryOne, execute } = require('../../src/db/pool')

async function columnInfo(table, column) {
  return queryOne(
    `SELECT IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  )
}

async function addColumn(table, column, definition, comment) {
  const c = await columnInfo(table, column)
  if (c) {
    console.log(`${table}.${column} 已存在，跳过`)
    return
  }
  await execute(`ALTER TABLE \`${table}\` ADD COLUMN ${definition} COMMENT '${comment}'`)
  console.log(`+ ${table}.${column}`)
}

async function main() {
  // 1) 明细：unit_price 改为可空
  const price = await columnInfo('inbound_order_items', 'unit_price')
  if (!price) throw new Error('inbound_order_items.unit_price 不存在，请先执行建库脚本')
  if (price.IS_NULLABLE === 'YES') {
    console.log('inbound_order_items.unit_price 已可空，跳过')
  } else {
    await execute(
      `ALTER TABLE inbound_order_items
         MODIFY COLUMN unit_price DECIMAL(14,4) DEFAULT NULL
         COMMENT '单价；NULL=待补价（成品仓上线初期没有价格）'`
    )
    console.log('~ inbound_order_items.unit_price 改为可空')
  }

  // 2) 明细：待补价标记
  await addColumn(
    'inbound_order_items',
    'price_pending',
    '`price_pending` TINYINT NOT NULL DEFAULT 0',
    '1=单价待补（未参与加权成本，补价后清零）'
  )

  // 3) 主表：待补项计数（冗余，供列表筛选）
  await addColumn(
    'inbound_orders',
    'pending_count',
    '`pending_count` INT NOT NULL DEFAULT 0',
    '本单有几项单价待补（0=金额完整）'
  )

  // 4) 兜底：历史数据回填（老数据 unit_price 都是 NOT NULL，pending_count 应为 0）
  const backfill = await queryOne(
    'SELECT COUNT(*) c FROM inbound_order_items WHERE price_pending = 1 AND unit_price IS NOT NULL'
  )
  if (Number(backfill.c) > 0) {
    await execute('UPDATE inbound_order_items SET price_pending = 0 WHERE unit_price IS NOT NULL AND price_pending = 1')
    console.log(`~ 修正 ${backfill.c} 条「有价却标待补」的历史明细`)
  }

  const stat = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM inbound_order_items WHERE price_pending = 1) AS pending_items,
       (SELECT COUNT(*) FROM inbound_orders WHERE pending_count > 0) AS pending_orders`
  )
  console.log('当前待补价明细 =', stat.pending_items, '；含待补价的单据 =', stat.pending_orders)
  console.log('迁移完成')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
