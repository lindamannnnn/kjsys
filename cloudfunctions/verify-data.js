// 数据验证脚本
// 在微信开发者工具的云开发控制台 → 数据库 → 执行

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

exports.main = async (event, context) => {
  const results = {}

  // 检查集合数据量
  const collections = [
    'users',
    'materials',
    'outbound_orders',
    'inbound_orders',
    'stock_checks',
    'suppliers',
    'operation_logs',
    'settings',
    'stock_logs',
    'warehouses'
  ]

  for (const coll of collections) {
    try {
      const res = await db.collection(coll).count()
      results[coll] = res.total
    } catch (err) {
      results[coll] = err.message
    }
  }

  // 检查关键数据
  const checks = {
    warehouses: results.warehouses === 2,
    suppliers: results.suppliers === 5,
    settings: results.settings === 1,
    materials: results.materials === 1930
  }

  return {
    code: 0,
    data: {
      collections: results,
      checks: checks,
      allPassed: Object.values(checks).every(v => v === true)
    }
  }
}
