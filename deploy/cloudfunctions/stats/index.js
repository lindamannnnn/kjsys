// 统计云函数
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
      case 'overview':
        return await overview(wxContext, data)
      case 'trend':
        return await trend(wxContext, data)
      case 'stockList':
        return await stockList(wxContext, data)
      case 'orderFlow':
        return await orderFlow(wxContext, data)
      case 'warning':
        return await warning(wxContext, data)
      case 'stockFlow':
        return await stockFlow(wxContext, data)
      default:
        return { code: 404, message: '未知操作' }
    }
  } catch (err) {
    console.error(err)
    return { code: 500, message: err.message }
  }
}

// 总览统计
async function overview(wxContext, data) {
  const { date } = data // today, week, month

  const today = new Date()
  let startDate, endDate

  if (date === 'today') {
    startDate = new Date(today.toISOString().split('T')[0])
    endDate = new Date(today.toISOString().split('T')[0] + ' 23:59:59')
  } else if (date === 'week') {
    const weekStart = new Date(today)
    weekStart.setDate(today.getDate() - today.getDay())
    startDate = new Date(weekStart.toISOString().split('T')[0])
    endDate = new Date(today.toISOString().split('T')[0] + ' 23:59:59')
  } else {
    // month
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    startDate = monthStart
    endDate = new Date(today.toISOString().split('T')[0] + ' 23:59:59')
  }

  // 出库统计
  const outboundRes = await db.collection('outbound_orders')
    .where({
      created_at: _.gte(startDate).and(_.lte(endDate)),
      status: _.in(['confirmed', 'completed'])
    })
    .get()

  // 入库统计
  const inboundRes = await db.collection('inbound_orders')
    .where({
      created_at: _.gte(startDate).and(_.lte(endDate)),
      status: _.in(['confirmed', 'completed'])
    })
    .get()

  // 库存统计
  const materialsRes = await db.collection('materials').get()
  const materials = materialsRes.data

  const totalStock = materials.reduce((sum, m) => sum + m.current_stock, 0)
  const totalCost = materials.reduce((sum, m) => sum + (m.avg_cost * m.current_stock), 0)
  const warningList = materials.filter(m => m.current_stock <= m.warning_stock)

  return {
    code: 0,
    data: {
      today_out_count: outboundRes.data.length,
      today_in_count: inboundRes.data.length,
      total_stock: totalStock,
      total_cost: Number(totalCost.toFixed(2)),
      warning_count: warningList.length
    }
  }
}

// 趋势分析
async function trend(wxContext, data) {
  const { days = 7 } = data

  const dates = []
  const outData = []
  const inData = []

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    const dateStr = `${date.getMonth() + 1}/${date.getDate()}`
    dates.push(dateStr)

    const startOfDay = new Date(date.toISOString().split('T')[0])
    const endOfDay = new Date(date.toISOString().split('T')[0] + ' 23:59:59')

    // 出库
    const outRes = await db.collection('outbound_orders')
      .where({
        created_at: _.gte(startOfDay).and(_.lte(endOfDay)),
        status: _.in(['confirmed', 'completed'])
      })
      .count()
    outData.push(outRes.total)

    // 入库
    const inRes = await db.collection('inbound_orders')
      .where({
        created_at: _.gte(startOfDay).and(_.lte(endOfDay)),
        status: _.in(['confirmed', 'completed'])
      })
      .count()
    inData.push(inRes.total)
  }

  return {
    code: 0,
    data: {
      dates,
      outData,
      inData
    }
  }
}

// 库存台账
async function stockList(wxContext, data) {
  const { page = 1, pageSize = 20, keyword, warehouse_id, showWarningOnly } = data

  let query = db.collection('materials')

  if (warehouse_id) {
    query = query.where({ warehouse_id })
  }

  if (keyword) {
    query = query.where({
      $or: [
        { name: db.RegExp({ regexp: keyword, options: 'i' }) },
        { spec: db.RegExp({ regexp: keyword, options: 'i' }) }
      ]
    })
  }

  if (showWarningOnly) {
    query = query.where({
      current_stock: _.lte(db.command.ref('warning_stock'))
    })
  }

  const countRes = await query.count()
  const listRes = await query
    .orderBy('current_stock', 'asc')
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

// 单据流水
async function orderFlow(wxContext, data) {
  const { page = 1, pageSize = 20, type, startDate, endDate } = data

  let outboundQuery = db.collection('outbound_orders')
  let inboundQuery = db.collection('inbound_orders')

  if (type === 'out') {
    inboundQuery = null
  } else if (type === 'in') {
    outboundQuery = null
  }

  if (startDate && endDate) {
    const start = new Date(startDate)
    const end = new Date(endDate + ' 23:59:59')
    if (outboundQuery) outboundQuery = outboundQuery.where({ created_at: _.gte(start).and(_.lte(end)) })
    if (inboundQuery) inboundQuery = inboundQuery.where({ created_at: _.gte(start).and(_.lte(end)) })
  }

  const results = []

  if (outboundQuery) {
    const outRes = await outboundQuery.orderBy('created_at', 'desc').get()
    results.push(...outRes.data.map(o => ({ ...o, order_type: 'out' })))
  }

  if (inboundQuery) {
    const inRes = await inboundQuery.orderBy('created_at', 'desc').get()
    results.push(...inRes.data.map(o => ({ ...o, order_type: 'in' })))
  }

  // 按时间排序
  results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // 分页
  const start = (page - 1) * pageSize
  const end = start + pageSize

  return {
    code: 0,
    data: {
      list: results.slice(start, end),
      total: results.length,
      page,
      pageSize
    }
  }
}

// 库存预警
async function warning(wxContext, data) {
  const materialsRes = await db.collection('materials').get()
  const materials = materialsRes.data

  const warningList = materials.filter(m => m.current_stock <= m.warning_stock)

  return {
    code: 0,
    data: warningList.map(m => ({
      _id: m._id,
      name: m.name,
      spec: m.spec,
      current_stock: m.current_stock,
      warning_stock: m.warning_stock,
      unit: m.unit,
      warehouse_id: m.warehouse_id
    }))
  }
}

// 库存流水
async function stockFlow(wxContext, data) {
  const { page = 1, pageSize = 20, material_id, startDate, endDate } = data

  let query = db.collection('stock_logs')

  if (material_id) {
    query = query.where({ material_id })
  }

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
