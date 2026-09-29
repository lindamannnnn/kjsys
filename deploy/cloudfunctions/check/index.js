// 盘点云函数
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
      case 'create':
        return await create(wxContext, data)
      case 'list':
        return await list(wxContext, data)
      case 'detail':
        return await detail(data)
      case 'submit':
        return await submit(wxContext, data)
      case 'review':
        return await review(wxContext, data)
      default:
        return { code: 404, message: '未知操作' }
    }
  } catch (err) {
    console.error(err)
    return { code: 500, message: err.message }
  }
}

// 创建盘点任务
async function create(wxContext, data) {
  const { OPENID } = wxContext
  const { type, scope, assignee_openids } = data

  // 获取用户信息
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}

  // 生成盘点单号
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const countRes = await db.collection('stock_checks')
    .where({ check_no: db.RegExp({ regexp: `CHK-${today}` }) })
    .count()
  const checkNo = `CHK-${today}-${String(countRes.total + 1).padStart(3, '0')}`

  // 根据范围查询物料
  let materialQuery = db.collection('materials')
  if (scope && scope.categories && scope.categories.length > 0) {
    materialQuery = materialQuery.where({ category: _.in(scope.categories) })
  }
  if (scope && scope.material_ids && scope.material_ids.length > 0) {
    materialQuery = materialQuery.where({ _id: _.in(scope.material_ids) })
  }

  const materialsRes = await materialQuery.get()
  const materials = materialsRes.data

  const checkData = {
    check_no: checkNo,
    type: type || 'partial',
    scope: scope || {},
    items: materials.map(m => ({
      material_id: m._id,
      material_name: m.name,
      material_spec: m.spec,
      book_stock: m.current_stock,
      actual_stock: null,
      difference: null
    })),
    freeze_stock: true,
    assignee_openids: assignee_openids || [],
    operator_openid: OPENID,
    operator_name: user.real_name || '未知用户',
    status: 'pending',
    created_at: db.serverDate()
  }

  const res = await db.collection('stock_checks').add({
    data: checkData
  })

  return {
    code: 0,
    data: {
      check_no: checkNo,
      _id: res._id
    },
    message: '盘点任务创建成功'
  }
}

// 盘点任务列表
async function list(wxContext, data) {
  const { OPENID } = wxContext
  const { page = 1, pageSize = 20, status } = data

  // 获取用户角色
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}
  const roles = user.roles || []

  let query = db.collection('stock_checks')

  // 仓管员只能看自己分配的
  if (!roles.includes('boss') && !roles.includes('admin')) {
    query = query.where({
      assignee_openids: OPENID
    })
  }

  if (status) {
    query = query.where({ status })
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

// 盘点详情
async function detail(data) {
  const { id } = data

  const res = await db.collection('stock_checks').doc(id).get()

  if (!res.data) {
    return { code: 404, message: '盘点单不存在' }
  }

  return {
    code: 0,
    data: res.data
  }
}

// 提交盘点结果
async function submit(wxContext, data) {
  const { OPENID } = wxContext
  const { id, items } = data

  const checkRes = await db.collection('stock_checks').doc(id).get()
  const check = checkRes.data

  if (!check) {
    return { code: 404, message: '盘点单不存在' }
  }

  if (check.status !== 'pending' && check.status !== 'in_progress') {
    return { code: 400, message: '盘点单已提交或已审核' }
  }

  // 更新盘点项
  const updatedItems = check.items.map(item => {
    const submitted = items.find(i => i.material_id === item.material_id)
    if (submitted) {
      return {
        ...item,
        actual_stock: Number(submitted.actual_stock),
        difference: Number(submitted.actual_stock) - item.book_stock
      }
    }
    return item
  })

  await db.collection('stock_checks').doc(id).update({
    data: {
      items: updatedItems,
      status: 'pending_review',
      submitted_at: db.serverDate()
    }
  })

  return { code: 0, message: '盘点结果提交成功，等待审核' }
}

// 审核盘点结果
async function review(wxContext, data) {
  const { OPENID } = wxContext
  const { id, action } = data // action: 'approve' or 'reject'

  // 检查权限
  const userRes = await db.collection('users').where({ openid: OPENID }).get()
  const user = userRes.data[0] || {}
  const roles = user.roles || []

  if (!roles.includes('boss') && !roles.includes('admin')) {
    return { code: 403, message: '无权限审核盘点' }
  }

  const checkRes = await db.collection('stock_checks').doc(id).get()
  const check = checkRes.data

  if (!check) {
    return { code: 404, message: '盘点单不存在' }
  }

  if (check.status !== 'pending_review') {
    return { code: 400, message: '盘点单不在待审核状态' }
  }

  if (action === 'approve') {
    // 审核通过，更新库存
    const transaction = await db.startTransaction()

    try {
      for (const item of check.items) {
        if (item.difference !== 0) {
          const materialRes = await transaction.collection('materials').doc(item.material_id).get()
          const material = materialRes.data

          if (material) {
            await transaction.collection('materials').doc(item.material_id).update({
              data: {
                current_stock: item.actual_stock,
                updated_at: db.serverDate()
              }
            })

            // 记录库存流水
            await transaction.collection('stock_logs').add({
              data: {
                material_id: item.material_id,
                material_name: material.name,
                warehouse_id: material.warehouse_id,
                change_type: 'check',
                change_quantity: item.difference,
                before_stock: item.book_stock,
                after_stock: item.actual_stock,
                related_order_id: check.check_no,
                related_order_type: 'check',
                operator_openid: OPENID,
                operator_name: user.real_name || '未知用户',
                created_at: db.serverDate()
              }
            })
          }
        }
      }

      await transaction.collection('stock_checks').doc(id).update({
        data: {
          status: 'completed',
          reviewer_openid: OPENID,
          reviewer_name: user.real_name || '未知用户',
          reviewed_at: db.serverDate(),
          completed_at: db.serverDate()
        }
      })

      await transaction.commit()

      return { code: 0, message: '盘点审核通过，库存已更新' }
    } catch (err) {
      await transaction.rollback()
      throw err
    }
  } else {
    // 驳回
    await db.collection('stock_checks').doc(id).update({
      data: {
        status: 'in_progress',
        reviewer_openid: OPENID,
        reviewer_name: user.real_name || '未知用户',
        reviewed_at: db.serverDate()
      }
    })

    return { code: 0, message: '盘点已驳回，请重新盘点' }
  }
}
