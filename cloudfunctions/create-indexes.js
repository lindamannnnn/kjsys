// 数据库索引创建脚本
// 在微信开发者工具的云开发控制台 → 数据库 → 执行

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

exports.main = async (event, context) => {
  const results = []

  // 云数据库没有直接创建索引的 API
  // 索引需要在云开发控制台手动创建
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
