// 数据库初始化完整脚本
// 在微信开发者工具的云开发控制台 → 数据库 → 执行

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
      case 'createCollections':
        return await createCollections()
      case 'createIndexes':
        return await createIndexes()
      case 'initData':
        return await initData()
      case 'cleanTestData':
        return await cleanTestData()
      case 'importMaterials':
        return await importMaterials()
      case 'fullInit':
        await createCollections()
        await createIndexes()
        await initData()
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

// 1. 创建集合
async function createCollections() {
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

  const results = {}

  for (const coll of collections) {
    try {
      // 云数据库没有直接创建集合的 API，通过插入一条数据再删除来创建
      await db.collection(coll).add({
        data: { _temp: true }
      })
      await db.collection(coll).where({ _temp: true }).remove()
      results[coll] = 'created'
    } catch (err) {
      results[coll] = err.message
    }
  }

  return {
    code: 0,
    message: '集合创建完成',
    data: results
  }
}

// 2. 创建索引
async function createIndexes() {
  // 云数据库的索引需要在控制台手动创建
  // 这里返回需要创建的索引列表

  const indexes = [
    // users 集合
    { collection: 'users', field: 'openid', unique: true },
    { collection: 'users', field: 'status', unique: false },
    { collection: 'users', field: 'roles', unique: false },

    // materials 集合
    { collection: 'materials', field: 'warehouse_id', unique: false },
    { collection: 'materials', field: 'category', unique: false },
    { collection: 'materials', field: 'name', unique: false },

    // outbound_orders 集合
    { collection: 'outbound_orders', field: 'order_no', unique: true },
    { collection: 'outbound_orders', field: 'status', unique: false },
    { collection: 'outbound_orders', field: 'operator_openid', unique: false },
    { collection: 'outbound_orders', field: 'created_at', unique: false },

    // inbound_orders 集合
    { collection: 'inbound_orders', field: 'order_no', unique: true },
    { collection: 'inbound_orders', field: 'status', unique: false },
    { collection: 'inbound_orders', field: 'operator_openid', unique: false },
    { collection: 'inbound_orders', field: 'supplier', unique: false },
    { collection: 'inbound_orders', field: 'created_at', unique: false },

    // stock_checks 集合
    { collection: 'stock_checks', field: 'check_no', unique: true },
    { collection: 'stock_checks', field: 'status', unique: false },
    { collection: 'stock_checks', field: 'assignee_openids', unique: false },

    // stock_logs 集合
    { collection: 'stock_logs', field: 'material_id', unique: false },
    { collection: 'stock_logs', field: 'created_at', unique: false },
    { collection: 'stock_logs', field: 'related_order_id', unique: false },

    // operation_logs 集合
    { collection: 'operation_logs', field: 'openid', unique: false },
    { collection: 'operation_logs', field: 'created_at', unique: false }
  ]

  return {
    code: 0,
    message: '索引列表已生成，请在云开发控制台手动创建',
    data: indexes
  }
}

// 3. 初始化数据
async function initData() {
  const results = {}

  // 插入仓库数据
  try {
    await db.collection('warehouses').add({
      data: {
        _id: 'peijian',
        name: '配件仓',
        code: 'peijian',
        description: '配件类物料仓库'
      }
    })
    await db.collection('warehouses').add({
      data: {
        _id: 'chengpin',
        name: '成品仓',
        code: 'chengpin',
        description: '成品类物料仓库'
      }
    })
    results.warehouses = 'created'
  } catch (err) {
    results.warehouses = err.message
  }

  // 插入供应商数据
  try {
    const suppliers = [
      { _id: 'sup001', name: '广州汽配供应商', contact: '陈经理', phone: '13800138001', tax_no: '91440101MA9W123456', address: '广州市白云区汽配城 A12', payment_terms: '月结30天' },
      { _id: 'sup002', name: '轮胎专卖店', contact: '刘老板', phone: '13800138002', tax_no: '91440101MA9W123457', address: '佛山市南海区轮胎市场 B08', payment_terms: '现结' },
      { _id: 'sup003', name: '电池供应商', contact: '张总', phone: '13800138003', tax_no: '91440101MA9W123458', address: '深圳市宝安区电池产业园', payment_terms: '月结15天' },
      { _id: 'sup004', name: '悬挂系统专供', contact: '李经理', phone: '13800138004', tax_no: '91440101MA9W123459', address: '东莞市寮步镇汽配路 88 号', payment_terms: '月结30天' },
      { _id: 'sup005', name: '制动系统专供', contact: '王主管', phone: '13800138005', tax_no: '91440101MA9W123460', address: '广州市黄埔区制动工业园', payment_terms: '现结' }
    ]

    for (const sup of suppliers) {
      await db.collection('suppliers').add({
        data: sup
      })
    }
    results.suppliers = 'created'
  } catch (err) {
    results.suppliers = err.message
  }

  // 插入系统设置
  try {
    await db.collection('settings').add({
      data: {
        _id: 'system',
        company_name: '胜龙汽配',
        warning_enabled: true,
        backup_enabled: true,
        order_no_prefix_out: 'OUT',
        order_no_prefix_in: 'IN'
      }
    })
    results.settings = 'created'
  } catch (err) {
    results.settings = err.message
  }

  return {
    code: 0,
    message: '初始化数据完成',
    data: results
  }
}

// 4. 清理测试数据
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

// 5. 导入真实物料数据
async function importMaterials() {
  const materials = require('./materials-init.json')

  const results = {
    total: materials.length,
    success: 0,
    failed: 0,
    errors: []
  }

  // 分批导入（每批 50 条，避免超时）
  const batchSize = 50
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

    // 每批之间暂停一下
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  return {
    code: 0,
    message: '物料数据导入完成',
    data: results
  }
}
