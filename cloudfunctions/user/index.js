// 用户管理云函数（Web 后台）
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
      case 'list':
        return await list(wxContext, data)
      case 'approve':
        return await approve(wxContext, data)
      case 'disable':
        return await disable(wxContext, data)
      case 'enable':
        return await enable(wxContext, data)
      case 'updateRole':
        return await updateRole(wxContext, data)
      default:
        return { code: 404, message: '未知操作' }
    }
  } catch (err) {
    console.error(err)
    return { code: 500, message: err.message }
  }
}

// 用户列表（仅老板/管理员）
async function list(wxContext, data) {
  const { page = 1, pageSize = 20, status, role } = data

  // 检查权限
  const userRes = await db.collection('users').where({ openid: wxContext.OPENID }).get()
  const currentUser = userRes.data[0] || {}
  const roles = currentUser.roles || []

  if (!roles.includes('boss') && !roles.includes('admin')) {
    return { code: 403, message: '无权限查看用户列表' }
  }

  let query = db.collection('users')

  if (status) {
    query = query.where({ status })
  }

  if (role) {
    query = query.where({ roles: _.in([role]) })
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

// 审核用户（分配角色）
async function approve(wxContext, data) {
  const { userId, roles, warehouse_ids } = data

  // 检查权限
  const userRes = await db.collection('users').where({ openid: wxContext.OPENID }).get()
  const currentUser = userRes.data[0] || {}
  const currentRoles = currentUser.roles || []

  if (!currentRoles.includes('boss') && !currentRoles.includes('admin')) {
    return { code: 403, message: '无权限审核用户' }
  }

  await db.collection('users').doc(userId).update({
    data: {
      roles: roles || [],
      warehouse_ids: warehouse_ids || [],
      status: 'active',
      approved_at: db.serverDate(),
      approved_by: currentUser.real_name || '未知用户'
    }
  })

  // 记录操作日志
  await db.collection('operation_logs').add({
    data: {
      openid: wxContext.OPENID,
      action: 'user_approve',
      target_type: 'user',
      target_id: userId,
      detail: `审核用户，分配角色: ${roles.join(', ')}`,
      created_at: db.serverDate()
    }
  })

  return { code: 0, message: '审核成功' }
}

// 禁用用户
async function disable(wxContext, data) {
  const { userId } = data

  // 检查权限
  const userRes = await db.collection('users').where({ openid: wxContext.OPENID }).get()
  const currentUser = userRes.data[0] || {}
  const roles = currentUser.roles || []

  if (!roles.includes('boss') && !roles.includes('admin')) {
    return { code: 403, message: '无权限禁用用户' }
  }

  await db.collection('users').doc(userId).update({
    data: {
      status: 'disabled',
      disabled_at: db.serverDate(),
      disabled_by: currentUser.real_name || '未知用户'
    }
  })

  return { code: 0, message: '禁用成功' }
}

// 启用用户
async function enable(wxContext, data) {
  const { userId } = data

  // 检查权限
  const userRes = await db.collection('users').where({ openid: wxContext.OPENID }).get()
  const currentUser = userRes.data[0] || {}
  const roles = currentUser.roles || []

  if (!roles.includes('boss') && !roles.includes('admin')) {
    return { code: 403, message: '无权限启用用户' }
  }

  await db.collection('users').doc(userId).update({
    data: {
      status: 'active',
      enabled_at: db.serverDate(),
      enabled_by: currentUser.real_name || '未知用户'
    }
  })

  return { code: 0, message: '启用成功' }
}

// 更新用户角色
async function updateRole(wxContext, data) {
  const { userId, roles, warehouse_ids } = data

  // 检查权限
  const userRes = await db.collection('users').where({ openid: wxContext.OPENID }).get()
  const currentUser = userRes.data[0] || {}
  const currentRoles = currentUser.roles || []

  if (!currentRoles.includes('boss') && !currentRoles.includes('admin')) {
    return { code: 403, message: '无权限修改用户角色' }
  }

  await db.collection('users').doc(userId).update({
    data: {
      roles: roles || [],
      warehouse_ids: warehouse_ids || [],
      updated_at: db.serverDate()
    }
  })

  return { code: 0, message: '角色更新成功' }
}
