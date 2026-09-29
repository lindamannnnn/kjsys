// 出库单云函数
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
      case 'cancel':
        return await cancel(wxContext, data)
      case 'confirm':
        return await confirm(wxContext, data)
      case 'reject':
        return await reject(wxContext, data)
      default:
        return { code: 404, message: '未知操作' }
    }
  } catch (err) {
    console.error(err)
    return { code: 500, message: err.message }
  }
}

// 提交出库单（支持批量）
async function submit(wxContext, data) {
  const { OPENID } = wxContext
  const { items, type, remark } = data

  if (!items || items.length === 0) {
    return { code: 400, message: '出库项不能为空' }
  }

  // 获取用户信息
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}

  // 生成单号
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const countRes = await db.collection('outbound_orders')
    .where({ order_no: db.RegExp({ regexp: `OUT-${today}` }) })
    .count()
  const orderNo = `OUT-${today}-${String(countRes.total + 1).padStart(3, '0')}`

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    // 逐个处理出库项
    for (const item of items) {
      const materialRes = await transaction.collection('materials').doc(item.material_id).get()
      const material = materialRes.data

      if (!material) {
        throw new Error(`物料不存在: ${item.material_name}`)
      }

      if (material.current_stock < item.quantity) {
        throw new Error(`库存不足: ${item.material_name} 当前库存 ${material.current_stock}，需要 ${item.quantity}`)
      }

      // 扣减库存
      await transaction.collection('materials').doc(item.material_id).update({
        data: {
          current_stock: material.current_stock - item.quantity,
          updated_at: db.serverDate()
        }
      })

      // 记录库存流水
      await transaction.collection('stock_logs').add({
        data: {
          material_id: item.material_id,
          material_name: material.name,
          warehouse_id: material.warehouse_id,
          change_type: 'outbound',
          change_quantity: -item.quantity,
          before_stock: material.current_stock,
          after_stock: material.current_stock - item.quantity,
          related_order_id: orderNo,
          related_order_type: 'outbound',
          operator_openid: OPENID,
          operator_name: user.real_name || '未知用户',
          created_at: db.serverDate()
        }
      })
    }

    // 创建出库单
    const orderData = {
      order_no: orderNo,
      warehouse_id: items[0].warehouse_id || 'peijian',
      type: type || 'lingyong',
      items: items.map(item => ({
        material_id: item.material_id,
        material_name: item.material_name,
        material_spec: item.material_spec,
        quantity: item.quantity,
        unit: item.unit
      })),
      operator_openid: OPENID,
      operator_name: user.real_name || '未知用户',
      remark: remark || '',
      status: 'pending',
      created_at: db.serverDate()
    }

    const orderRes = await transaction.collection('outbound_orders').add({
      data: orderData
    })

    // 记录操作日志
    await transaction.collection('operation_logs').add({
      data: {
        openid: OPENID,
        action: 'outbound_submit',
        target_type: 'order',
        target_id: orderRes._id,
        detail: `提交出库单 ${orderNo}，共 ${items.length} 项`,
        created_at: db.serverDate()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      data: {
        order_no: orderNo,
        _id: orderRes._id
      },
      message: '出库单提交成功'
    }
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 出库单列表
async function list(wxContext, data) {
  const { OPENID } = wxContext
  const { page = 1, pageSize = 20, status, startDate, endDate } = data

  // 获取用户角色
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}
  const roles = user.roles || []

  let query = db.collection('outbound_orders')

  // 非老板只能看自己的
  if (!roles.includes('boss') && !roles.includes('admin')) {
    query = query.where({ operator_openid: OPENID })
  }

  // 状态筛选
  if (status) {
    query = query.where({ status })
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

// 出库单详情
async function detail(data) {
  const { id } = data

  const res = await db.collection('outbound_orders').doc(id).get()

  if (!res.data) {
    return { code: 404, message: '单据不存在' }
  }

  return {
    code: 0,
    data: res.data
  }
}

// 撤销出库单（10分钟内 + 本人）
async function cancel(wxContext, data) {
  const { OPENID } = wxContext
  const { id } = data

  const orderRes = await db.collection('outbound_orders').doc(id).get()
  const order = orderRes.data

  if (!order) {
    return { code: 404, message: '单据不存在' }
  }

  if (order.operator_openid !== OPENID) {
    return { code: 403, message: '只能撤销自己的单据' }
  }

  if (order.status !== 'pending') {
    return { code: 400, message: '只有待确认的单据可以撤销' }
  }

  // 检查是否在10分钟内
  const createdTime = new Date(order.created_at).getTime()
  const now = Date.now()
  if (now - createdTime > 10 * 60 * 1000) {
    return { code: 400, message: '超过10分钟，无法撤销' }
  }

  // 开启事务恢复库存
  const transaction = await db.startTransaction()

  try {
    for (const item of order.items) {
      const materialRes = await transaction.collection('materials').doc(item.material_id).get()
      const material = materialRes.data

      if (material) {
        await transaction.collection('materials').doc(item.material_id).update({
          data: {
            current_stock: material.current_stock + item.quantity,
            updated_at: db.serverDate()
          }
        })

        // 记录库存流水
        await transaction.collection('stock_logs').add({
          data: {
            material_id: item.material_id,
            material_name: material.name,
            warehouse_id: material.warehouse_id,
            change_type: 'outbound_cancel',
            change_quantity: item.quantity,
            before_stock: material.current_stock,
            after_stock: material.current_stock + item.quantity,
            related_order_id: order.order_no,
            related_order_type: 'outbound',
            operator_openid: OPENID,
            operator_name: order.operator_name,
            created_at: db.serverDate()
          }
        })
      }
    }

    // 更新单据状态
    await transaction.collection('outbound_orders').doc(id).update({
      data: {
        status: 'cancelled',
        cancelled_at: db.serverDate()
      }
    })

    await transaction.commit()

    return { code: 0, message: '撤销成功，库存已恢复' }
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 确认出库单（仓管/老板）
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

  const orderRes = await db.collection('outbound_orders').doc(id).get()
  const order = orderRes.data

  if (!order) {
    return { code: 404, message: '单据不存在' }
  }

  if (order.status !== 'pending') {
    return { code: 400, message: '只有待确认的单据可以确认' }
  }

  await db.collection('outbound_orders').doc(id).update({
    data: {
      status: 'confirmed',
      confirm_operator_openid: OPENID,
      confirm_operator_name: user.real_name || '未知用户',
      confirmed_at: db.serverDate()
    }
  })

  return { code: 0, message: '确认成功' }
}

// 驳回出库单（老板）
async function reject(wxContext, data) {
  const { OPENID } = wxContext
  const { id, reason } = data

  // 检查权限
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}
  const roles = user.roles || []

  if (!roles.includes('boss') && !roles.includes('admin')) {
    return { code: 403, message: '无权限驳回单据' }
  }

  const orderRes = await db.collection('outbound_orders').doc(id).get()
  const order = orderRes.data

  if (!order) {
    return { code: 404, message: '单据不存在' }
  }

  if (order.status !== 'pending') {
    return { code: 400, message: '只有待确认的单据可以驳回' }
  }

  await db.collection('outbound_orders').doc(id).update({
    data: {
      status: 'rejected',
      reject_reason: reason || '',
      reject_operator_openid: OPENID,
      reject_operator_name: user.real_name || '未知用户',
      rejected_at: db.serverDate()
    }
  })

  return { code: 0, message: '驳回成功' }
}
