// 物料管理云函数
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { action, data } = event

  try {
    switch (action) {
      case 'list':
        return await list(data)
      case 'detail':
        return await detail(data)
      case 'upsert':
        return await upsert(data)
      case 'import':
        return await importMaterials(data)
      case 'delete':
        return await remove(data)
      default:
        return { code: 404, message: '未知操作' }
    }
  } catch (err) {
    console.error(err)
    return { code: 500, message: err.message }
  }
}

// 物料列表（支持搜索、分页、仓库筛选）
async function list(data) {
  const { keyword = '', page = 1, pageSize = 20, warehouse_id, category, showWarningOnly } = data

  let query = db.collection('materials')

  // 仓库筛选
  if (warehouse_id) {
    query = query.where({ warehouse_id })
  }

  // 分类筛选
  if (category) {
    query = query.where({ category })
  }

  // 预警筛选
  if (showWarningOnly) {
    query = query.where({
      current_stock: _.lte(db.command.ref('warning_stock'))
    })
  }

  // 关键词搜索
  if (keyword) {
    query = query.where({
      $or: [
        { name: db.RegExp({ regexp: keyword, options: 'i' }) },
        { spec: db.RegExp({ regexp: keyword, options: 'i' }) }
      ]
    })
  }

  // 分页
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

// 物料详情
async function detail(data) {
  const { id } = data

  const res = await db.collection('materials').doc(id).get()

  if (!res.data) {
    return { code: 404, message: '物料不存在' }
  }

  return {
    code: 0,
    data: res.data
  }
}

// 新增/编辑物料
async function upsert(data) {
  const { _id, name, spec, category, unit, warehouse_id, warning_stock, image_fileid } = data

  if (!name || !warehouse_id) {
    return { code: 400, message: '物料名称和仓库不能为空' }
  }

  const materialData = {
    name,
    spec: spec || '',
    category: category || '',
    unit: unit || '个',
    warehouse_id,
    warning_stock: warning_stock || 10,
    image_fileid: image_fileid || '',
    updated_at: db.serverDate()
  }

  if (_id) {
    // 编辑
    await db.collection('materials').doc(_id).update({
      data: materialData
    })
    return { code: 0, message: '更新成功' }
  } else {
    // 新增
    materialData.current_stock = 0
    materialData.avg_cost = 0
    materialData.created_at = db.serverDate()

    const res = await db.collection('materials').add({
      data: materialData
    })
    return { code: 0, data: { _id: res._id }, message: '创建成功' }
  }
}

// 批量导入物料
async function importMaterials(data) {
  const { materials } = data

  if (!materials || !Array.isArray(materials)) {
    return { code: 400, message: '物料数据格式错误' }
  }

  const results = []
  for (const item of materials) {
    try {
      const res = await db.collection('materials').add({
        data: {
          name: item.name,
          spec: item.spec || '',
          category: item.category || '',
          unit: item.unit || '个',
          warehouse_id: item.warehouse_id || 'peijian',
          current_stock: 0,
          warning_stock: item.warning_stock || 10,
          avg_cost: 0,
          created_at: db.serverDate(),
          updated_at: db.serverDate()
        }
      })
      results.push({ success: true, _id: res._id, name: item.name })
    } catch (err) {
      results.push({ success: false, name: item.name, error: err.message })
    }
  }

  return {
    code: 0,
    data: {
      total: materials.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    }
  }
}

// 删除物料（软删除）
async function remove(data) {
  const { id } = data

  await db.collection('materials').doc(id).update({
    data: {
      is_deleted: true,
      updated_at: db.serverDate()
    }
  })

  return { code: 0, message: '删除成功' }
}
