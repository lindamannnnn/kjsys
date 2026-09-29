// 入库单云函数
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const { action, data } = event

  try {
    switch (action) {
      case 'submit':
        return await submit(wxContext, data)
      case 'list':
        return await list(wxContext, data)
      case 'detail':
        return await detail(data)
      case 'updatePrice':
        return await updatePrice(wxContext, data)
      case 'confirm':
        return await confirm(wxContext, data)
      default:
        return { code: 404, message: '未知操作' }
    }
  } catch (err) {
    console.error(err)
    return { code: 500, message: err.message }
  }
}

// 提交入库单（支持批量）
async function submit(wxContext, data) {
  const { OPENID } = wxContext
  const { items, supplier, remark } = data

  if (!items || items.length === 0) {
    return { code: 400, message: '入库项不能为空' }
  }

  // 获取用户信息
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}

  // 生成单号
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const countRes = await db.collection('inbound_orders')
    .where({ order_no: db.RegExp({ regexp: `IN-${today}` }) })
    .count()
  const orderNo = `IN-${today}-${String(countRes.total + 1).padStart(3, '0')}`

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    let totalPrice = 0

    for (const item of items) {
      const materialRes = await transaction.collection('materials').doc(item.material_id).get()
      const material = materialRes.data

      if (!material) {
        throw new Error(`物料不存在: ${item.material_name}`)
      }

      const qty = Number(item.quantity)
      const price = Number(item.unit_price)
      totalPrice += qty * price

      // 更新库存成本（加权平均）
      const oldTotal = material.avg_cost * material.current_stock
      const newTotal = price * qty
      const totalQty = material.current_stock + qty
      const newAvgCost = totalQty > 0 ? Number(((oldTotal + newTotal) / totalQty).toFixed(2)) : 0

      await transaction.collection('materials').doc(item.material_id).update({
        data: {
          current_stock: totalQty,
          avg_cost: newAvgCost,
          updated_at: db.serverDate()
        }
      })

      // 记录库存流水
      await transaction.collection('stock_logs').add({
        data: {
          material_id: item.material_id,
          material_name: material.name,
          warehouse_id: material.warehouse_id,
          change_type: 'inbound',
          change_quantity: qty,
          before_stock: material.current_stock,
          after_stock: totalQty,
          related_order_id: orderNo,
          related_order_type: 'inbound',
          operator_openid: OPENID,
          operator_name: user.real_name || '未知用户',
          created_at: db.serverDate()
        }
      })
    }

    // 创建入库单
    const orderData = {
      order_no: orderNo,
      warehouse_id: items[0].warehouse_id || 'peijian',
      type: 'purchase',
      items: items.map(item => ({
        material_id: item.material_id,
        material_name: item.material_name,
        material_spec: item.material_spec,
        quantity: Number(item.quantity),
        unit: item.unit,
        unit_price: Number(item.unit_price),
        total_price: Number((Number(item.quantity) * Number(item.unit_price)).toFixed(2))
      })),
      supplier: supplier || '',
      total_price: Number(totalPrice.toFixed(2)),
      operator_openid: OPENID,
      operator_name: user.real_name || '未知用户',
      remark: remark || '',
      status: 'pending',
      created_at: db.serverDate()
    }

    const orderRes = await transaction.collection('inbound_orders').add({
      data: orderData
    })

    // 记录操作日志
    await transaction.collection('operation_logs').add({
      data: {
        openid: OPENID,
        action: 'inbound_submit',
        target_type: 'order',
        target_id: orderRes._id,
        detail: `提交入库单 ${orderNo}，共 ${items.length} 项，合计 ¥${totalPrice.toFixed(2)}`,
        created_at: db.serverDate()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      data: {
        order_no: orderNo,
        _id: orderRes._id,
        total_price: totalPrice.toFixed(2)
      },
      message: '入库单提交成功'
    }
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 入库单列表
async function list(wxContext, data) {
  const { OPENID } = wxContext
  const { page = 1, pageSize = 20, status, startDate, endDate, supplier } = data

  // 获取用户角色
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}
  const roles = user.roles || []

  let query = db.collection('inbound_orders')

  // 非老板只能看自己的
  if (!roles.includes('boss') && !roles.includes('admin')) {
    query = query.where({ operator_openid: OPENID })
  }

  // 状态筛选
  if (status) {
    query = query.where({ status })
  }

  // 供应商筛选
  if (supplier) {
    query = query.where({ supplier })
  }

  // 日期筛选
  if (startDate && endDate) {
    query = query.where({
      created_at: _.gte(new Date(startDate)).and(_.lte(new Date(endDate + ' 23:59:59')))
    })
  }

  const countRes = await query.count()
  const listRes = await query
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  return {
    code: 0,
    data: {
      list: listRes.data,
      total: countRes.total,
      page,
      pageSize
    }
  }
}

// 入库单详情
async function detail(data) {
  const { id } = data

  const res = await db.collection('inbound_orders').doc(id).get()

  if (!res.data) {
    return { code: 404, message: '单据不存在' }
  }

  return {
    code: 0,
    data: res.data
  }
}

// 修改单价（当天 + 本人）
async function updatePrice(wxContext, data) {
  const { OPENID } = wxContext
  const { id, unit_price } = data

  const orderRes = await db.collection('inbound_orders').doc(id).get()
  const order = orderRes.data

  if (!order) {
    return { code: 404, message: '单据不存在' }
  }

  if (order.operator_openid !== OPENID) {
    return { code: 403, message: '只能修改自己的单据' }
  }

  // 检查是否当天
  const createdTime = new Date(order.created_at).toDateString()
  const today = new Date().toDateString()
  if (createdTime !== today) {
    return { code: 400, message: '只能修改当天的单据' }
  }

  // 更新单价和小计
  const newItems = order.items.map(item => ({
    ...item,
    unit_price: Number(unit_price),
    total_price: Number((item.quantity * Number(unit_price)).toFixed(2))
  }))

  const newTotalPrice = newItems.reduce((sum, item) => sum + item.total_price, 0)

  await db.collection('inbound_orders').doc(id).update({
    data: {
      items: newItems,
      total_price: Number(newTotalPrice.toFixed(2)),
      updated_at: db.serverDate()
    }
  })

  return { code: 0, message: '修改成功' }
}

// 确认入库单（仓管/老板）
async function confirm(wxContext, data) {
  const { OPENID } = wxContext
  const { id } = data

  // 检查权限
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}
  const roles = user.roles || []

  if (!roles.includes('storekeeper') && !roles.includes('boss') && !roles.includes('admin')) {
    return { code: 403, message: '无权限确认单据' }
  }

  const orderRes = await db.collection('inbound_orders').doc(id).get()
  const order = orderRes.data

  if (!order) {
    return { code: 404, message: '单据不存在' }
  }

  if (order.status !== 'pending') {
    return { code: 400, message: '只有待确认的单据可以确认' }
  }

  await db.collection('inbound_orders').doc(id).update({
    data: {
      status: 'confirmed',
      confirm_operator_openid: OPENID,
      confirm_operator_name: user.real_name || '未知用户',
      confirmed_at: db.serverDate()
    }
  })

  return { code: 0, message: '确认成功' }
}
