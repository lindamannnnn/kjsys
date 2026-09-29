// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const { action, data } = event

  try {
    switch (action) {
      case 'login':
        return await login(wxContext)
      case 'register':
        return await register(wxContext, data)
      case 'updateProfile':
        return await updateProfile(wxContext, data)
      case 'getUserInfo':
        return await getUserInfo(wxContext)
      default:
        return {
          code: 404,
          message: '未知操作'
        }
    }
  } catch (err) {
    console.error(err)
    return {
      code: 500,
      message: err.message
    }
  }
}

// 登录/获取用户信息
async function login(wxContext) {
  const { OPENID } = wxContext

  // 查询用户
  const userRes = await db.collection('users').where({
    openid: OPENID
  }).get()

  if (userRes.data.length > 0) {
    const user = userRes.data[0]
    // 更新最后登录时间
    await db.collection('users').doc(user._id).update({
      data: {
        last_login_at: db.serverDate()
      }
    })

    return {
      code: 0,
      data: {
        openid: OPENID,
        user: user,
        roles: user.roles || [],
        isNew: false
      }
    }
  }

  // 新用户，返回待注册状态
  return {
    code: 0,
    data: {
      openid: OPENID,
      user: null,
      roles: [],
      isNew: true
    }
  }
}

// 注册（填写真实姓名）
async function register(wxContext, data) {
  const { OPENID } = wxContext
  const { real_name, phone } = data

  if (!real_name) {
    return {
      code: 400,
      message: '真实姓名不能为空'
    }
  }

  // 检查是否已存在
  const existRes = await db.collection('users').where({
    openid: OPENID
  }).get()

  if (existRes.data.length > 0) {
    return {
      code: 400,
      message: '用户已存在'
    }
  }

  // 创建新用户（默认待审核状态）
  const newUser = {
    openid: OPENID,
    real_name: real_name,
    phone: phone || '',
    roles: [],
    status: 'pending',
    warehouse_ids: [],
    created_at: db.serverDate(),
    last_login_at: db.serverDate()
  }

  const res = await db.collection('users').add({
    data: newUser
  })

  // 记录操作日志
  await db.collection('operation_logs').add({
    data: {
      openid: OPENID,
      action: 'register',
      target_type: 'user',
      target_id: res._id,
      detail: `新用户注册: ${real_name}`,
      created_at: db.serverDate()
    }
  })

  return {
    code: 0,
    data: {
      _id: res._id,
      ...newUser
    },
    message: '注册成功，等待审核'
  }
}

// 更新用户资料
async function updateProfile(wxContext, data) {
  const { OPENID } = wxContext
  const { real_name, phone } = data

  const userRes = await db.collection('users').where({
    openid: OPENID
  }).get()

  if (userRes.data.length === 0) {
    return {
      code: 404,
      message: '用户不存在'
    }
  }

  const user = userRes.data[0]
  const updateData = {}

  if (real_name) updateData.real_name = real_name
  if (phone) updateData.phone = phone

  await db.collection('users').doc(user._id).update({
    data: updateData
  })

  return {
    code: 0,
    message: '更新成功'
  }
}

// 获取当前用户信息
async function getUserInfo(wxContext) {
  const { OPENID } = wxContext

  const userRes = await db.collection('users').where({
    openid: OPENID
  }).get()

  if (userRes.data.length === 0) {
    return {
      code: 404,
      message: '用户不存在'
    }
  }

  return {
    code: 0,
    data: userRes.data[0]
  }
}
