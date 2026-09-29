// 清理测试数据并导入真实物料数据
// 在微信开发者工具的云函数中运行

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { action } = event

  try {
    switch (action) {
      case 'clean':
        return await cleanTestData()
      case 'import':
        return await importMaterials()
      case 'cleanAndImport':
        await cleanTestData()
        return await importMaterials()
      default:
        return { code: 400, message: '未知操作' }
    }
  } catch (err) {
    console.error(err)
    return { code: 500, message: err.message }
  }
}

// 清理测试数据
async function cleanTestData() {
  const collections = [
    'materials',
    'outbound_orders',
    'inbound_orders',
    'stock_checks',
    'stock_logs',
    'operation_logs'
  ]

  const results = {}

  for (const coll of collections) {
    try {
      // 删除所有数据（云数据库没有 truncate，需要逐个删除）
      const res = await db.collection(coll).where({
        _id: _.exists(true)
      }).remove()
      results[coll] = { deleted: res.stats.removed }
    } catch (err) {
      results[coll] = { error: err.message }
    }
  }

  return {
    code: 0,
    message: '测试数据清理完成',
    data: results
  }
}

// 导入真实物料数据
async function importMaterials() {
  const materials = require('./materials-init.json')

  const results = {
    total: materials.length,
    success: 0,
    failed: 0,
    errors: []
  }

  // 批量插入（每批 100 条）
  const batchSize = 100
  for (let i = 0; i < materials.length; i += batchSize) {
    const batch = materials.slice(i, i + batchSize)

    for (const item of batch) {
      try {
        await db.collection('materials').add({
          data: {
            name: item.name,
            spec: item.spec || '',
            category: item.category,
            unit: item.unit,
            warehouse_id: item.warehouse_id,
            current_stock: item.current_stock || 0,
            warning_stock: item.warning_stock || 10,
            avg_cost: item.avg_cost || 0,
            is_deleted: false,
            created_at: db.serverDate(),
            updated_at: db.serverDate()
          }
        })
        results.success++
      } catch (err) {
        results.failed++
        results.errors.push({
          name: item.name,
          error: err.message
        })
      }
    }

    // 每批之间暂停一下，避免超时
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return {
    code: 0,
    message: '物料数据导入完成',
    data: results
  }
}
