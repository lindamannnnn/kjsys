/**
 * 改动的数据现状只读查看（临时探针，不入库）
 * 为「待拣货可撤 / 待收货不可撤」与「仓管可见本仓盘点单」两条改动挑验证样本
 */
require('../src/config/env')
const { query, queryOne } = require('../src/db/pool')

async function main() {
  console.log('='.repeat(72))
  console.log('  改动验证用的数据现状（只读）')
  console.log('='.repeat(72))

  console.log('\n[1] 进行中的出库单（picking / receiving）：')
  const orders = await query(
    `SELECT o.id, o.order_no, o.status, o.warehouse_id, o.operator_openid, o.operator_name,
            o.stock_deducted, o.remark
       FROM outbound_orders o
      WHERE o.is_deleted = 0 AND o.status IN ('picking','receiving')
      ORDER BY o.id DESC LIMIT 15`
  )
  if (!orders.length) console.log('   （无）')
  for (const r of orders) {
    console.log(`   ${r.order_no} | id=${r.id} | ${r.status} | 仓${r.warehouse_id} | 提交人=${r.operator_name}(${r.operator_openid}) | 已扣=${r.stock_deducted}`)
  }

  console.log('\n[2] 盘点单（看归属与仓库）：')
  const checks = await query(
    `SELECT c.id, c.check_no, c.status, c.warehouse_id, c.operator_openid, c.operator_name,
            c.assignee_openids
       FROM stock_checks c
      ORDER BY c.id DESC LIMIT 15`
  )
  if (!checks.length) console.log('   （无）')
  for (const r of checks) {
    console.log(`   ${r.check_no} | id=${r.id} | ${r.status} | 仓${r.warehouse_id} | 创建人=${r.operator_name}(${r.operator_openid}) | 指派=${r.assignee_openids}`)
  }

  console.log('\n[3] 岗位账号的角色与仓库范围：')
  const users = await query(
    `SELECT id, username, real_name, roles, warehouse_ids, openid
       FROM users
      WHERE username IN ('zhangshan','lina','zhaoliu','wangzong') OR real_name IN ('张三','李娜','赵六','王总')
      ORDER BY id`
  )
  for (const r of users) {
    console.log(`   ${r.real_name}(${r.username}) roles=${r.roles} warehouse_ids=${r.warehouse_ids} openid=${r.openid || '(空)'}`)
  }

  console.log('\n' + '='.repeat(72))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
