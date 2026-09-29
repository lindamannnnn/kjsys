/**
 * 物料档案模块
 *
 * ⚠️ 整改说明（来自 4 角色使用者测试，报告见 docs/4-ROLE-USER-TEST-REPORT.md）：
 *   P0-3.8 material/import 可携带 current_stock 无痕写入库存，一条 stock_logs 都不产生
 *          → 现在明确拒绝导入库存字段，库存只能通过入库单/盘点变更
 *   P2      material/upsert 带库存字段时返回"更新成功"但库存其实没动
 *          → 现在明确报错，不给出误导性的成功提示
 *   读接口按可管仓库收敛数据范围，写接口校验仓库权限
 * ============================================================
 */
const { query, queryOne, execute, withTransaction } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, toDbId, num, paging } = require('../utils/format')
const { warningStock } = require('../utils/validate')
const { resolveWarehouseId } = require('../services/warehouse')

/** 库存类字段：这些字段只能由库存流水（入库单/盘点）改变，档案接口不得写入 */
const STOCK_FIELDS = ['current_stock', 'avg_cost', 'stock', 'quantity']

/** 找出请求里携带的库存类字段（用于明确拒绝） */
function findStockFields(data = {}) {
  return STOCK_FIELDS.filter((f) => data[f] !== undefined && data[f] !== null && data[f] !== '')
}

/** 物料列表：支持关键词、仓库、分类、预警筛选与分页 */
async function list(ctx, data = {}) {
  const { keyword = '', category, sub_category: subCategory, showWarningOnly } = data
  const { page, pageSize, offset } = paging(data)

  const where = ['m.is_deleted = 0']
  const params = []

  // 仓库级数据权限
  const scope = ctx.warehouseScope('m', data.warehouse_id)
  if (scope.sql) {
    where.push(scope.sql.replace(/^AND\s+/, ''))
    params.push(...scope.params)
  }

  if (category) {
    where.push('m.category = ?')
    params.push(category)
  }
  // 细分类：成品仓=车间，配件仓=编号类目
  if (subCategory) {
    where.push('m.sub_category = ?')
    params.push(subCategory)
  }
  if (showWarningOnly) {
    where.push('m.warning_stock > 0 AND m.current_stock <= m.warning_stock')
  }
  if (keyword && String(keyword).trim()) {
    const kwRaw = String(keyword).trim()

    /*
     * 扫码进来的是「完整物料编号」（如 A001-1），必须精确命中。
     * 否则走模糊匹配会出事：'%A001-1%' 会把 A001-10 ~ A001-19 一起捞出来，
     * 对着货架扫一个码冒出 11 条，员工根本不知道该选哪个 —— 扫码就白做了。
     * 所以先探一下这是不是某个编号的完整值，是就直接锁定到那一条。
     */
    const exactNo = await queryOne(
      'SELECT id FROM materials WHERE material_no = ? AND is_deleted = 0 LIMIT 1',
      [kwRaw]
    )

    if (exactNo) {
      where.push('m.material_no = ?')
      params.push(kwRaw)
    } else {
      // 不是完整编号就按原来的模糊方式搜：名称 / 规格 / 分类 / 细分类 / 编号 / 条码
      const kw = `%${kwRaw}%`
      where.push(
        '(m.name LIKE ? OR m.spec LIKE ? OR m.category LIKE ? OR m.sub_category LIKE ?' +
          ' OR m.material_no LIKE ? OR m.barcode LIKE ?)'
      )
      params.push(kw, kw, kw, kw, kw, kw)
    }
  }

  const whereSql = where.join(' AND ')

  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM materials m WHERE ${whereSql}`, params)
  const rows = await query(
    `SELECT m.*, w.name AS warehouse_name, w.code AS warehouse_code
       FROM materials m
       LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE ${whereSql}
      ORDER BY m.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  return ok({
    list: toApi(rows),
    total: cnt.total,
    page,
    pageSize
  })
}

/** 物料详情 */
async function detail(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '物料 ID 无效')

  const row = await queryOne(
    `SELECT m.*, w.name AS warehouse_name, w.code AS warehouse_code
       FROM materials m LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.id = ? AND m.is_deleted = 0`,
    [id]
  )
  if (!row) return fail(404, '物料不存在')

  // 读详情也要受仓库权限约束
  if (!ctx.canAccessWarehouse(row.warehouse_id)) {
    return fail(403, '该物料不属于你有权查看的仓库')
  }

  return ok(toApi(row))
}

/** 新增 / 编辑物料 */
async function upsert(ctx, data = {}) {
  const {
    _id, name, spec, category, sub_category: subCategory, unit,
    warehouse_id: warehouseId, warning_stock: warningStockValue,
    material_no: materialNo, image_fileid: imageFileid, remark
  } = data

  // 库存类字段一律不允许经由档案接口写入（整改 P0-3.8 / P2）
  const stockFields = findStockFields(data)
  if (stockFields.length) {
    return fail(
      400,
      `物料档案不能直接修改库存（你传了：${stockFields.join('、')}）。` +
      `库存只能通过「入库单」或「盘点调整」变更，这样才能留下可追溯的流水与责任人`
    )
  }

  if (!name || !String(name).trim()) return fail(400, '物料名称不能为空')

  const wid = await resolveWarehouseId(warehouseId)
  if (!wid) return fail(400, '请选择所属仓库')
  ctx.requireWarehouseAccess(wid, '该物料')

  const cleanName = String(name).trim()
  const cleanSpec = String(spec || '').trim()

  // ---------- 编辑 ----------
  if (_id) {
    const id = toDbId(_id)
    const exist = await queryOne(
      'SELECT id, warehouse_id, material_no FROM materials WHERE id = ? AND is_deleted = 0',
      [id]
    )
    if (!exist) return fail(404, '物料不存在或已删除')
    // 原仓库也要有权限，防止把别仓物料"搬"过来
    ctx.requireWarehouseAccess(exist.warehouse_id, '该物料')

    // 改名后是否与同仓库其它物料重名
    const dup = await queryOne(
      'SELECT id FROM materials WHERE name = ? AND spec = ? AND warehouse_id = ? AND is_deleted = 0 AND id <> ?',
      [cleanName, cleanSpec, wid, id]
    )
    if (dup) return fail(409, '同仓库下已存在同名同规格物料，不能重复建档')

    // 编号：不传则保留原值（避免普通编辑把已录入的编号清掉）
    const finalNo =
      materialNo === undefined ? String(exist.material_no || '') : String(materialNo).trim()

    if (finalNo) {
      const dupNo = await queryOne(
        'SELECT id FROM materials WHERE material_no = ? AND warehouse_id = ? AND is_deleted = 0 AND id <> ?',
        [finalNo, wid, id]
      )
      if (dupNo) return fail(409, `该仓库下编号「${finalNo}」已被其它物料占用`)
    }

    await execute(
      `UPDATE materials
          SET name = ?, spec = ?, category = ?, sub_category = ?, material_no = ?, unit = ?,
              warehouse_id = ?, warning_stock = ?, image_fileid = ?, remark = ?
        WHERE id = ?`,
      [
        cleanName, cleanSpec, String(category || ''), String(subCategory || ''), finalNo,
        String(unit || '个'), wid,
        warningStock(warningStockValue, 10), String(imageFileid || ''), String(remark || ''), id
      ]
    )
    return ok({ _id: id }, '更新成功（库存与成本不受档案修改影响）')
  }

  // ---------- 新增 ----------
  const dup = await queryOne(
    'SELECT id, current_stock FROM materials WHERE name = ? AND spec = ? AND warehouse_id = ? AND is_deleted = 0',
    [cleanName, cleanSpec, wid]
  )
  if (dup) {
    return fail(409, `该仓库已存在同名同规格物料（当前库存 ${dup.current_stock}），如需修改请直接编辑`)
  }

  const finalNo = String(materialNo || '').trim()
  if (finalNo) {
    const dupNo = await queryOne(
      'SELECT id FROM materials WHERE material_no = ? AND warehouse_id = ? AND is_deleted = 0',
      [finalNo, wid]
    )
    if (dupNo) return fail(409, `该仓库下编号「${finalNo}」已被其它物料占用`)
  }

  const res = await execute(
    `INSERT INTO materials
       (name, spec, category, sub_category, material_no, unit, warehouse_id,
        current_stock, warning_stock, avg_cost, image_fileid, remark, is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 0, NOW(), NOW())`,
    [
      cleanName, cleanSpec, String(category || ''), String(subCategory || ''), finalNo,
      String(unit || '个'), wid,
      warningStock(warningStockValue, 10), String(imageFileid || ''), String(remark || '')
    ]
  )

  return ok({ _id: res.insertId }, '创建成功（新物料库存为 0，请通过入库单建账）')
}

/**
 * 批量导入物料
 * 策略：同名同规格同仓库的跳过（返回 skipped），其余插入
 * 安全约束（整改 P0-3.8）：**不接受任何库存字段**，库存只能通过入库单建立
 */
async function importMaterials(ctx, data = {}) {
  const items = data.materials
  if (!Array.isArray(items) || !items.length) {
    return fail(400, '物料数据格式错误或为空')
  }

  const result = { total: items.length, success: 0, skipped: 0, updated: 0, failed: 0, errors: [] }

  await withTransaction(async (conn) => {
    for (const item of items) {
      try {
        const name = String(item.name || '').trim()
        if (!name) {
          result.failed++
          result.errors.push({ name: item.name, error: '物料名称为空' })
          continue
        }

        // 库存字段一律拒绝：否则就是"凭空写库存且查不出人"（老板最痛的场景）
        const bad = findStockFields(item)
        if (bad.length) {
          result.failed++
          result.errors.push({
            name,
            error: `不允许导入库存字段（${bad.join('、')}）。库存请用「入库单」建立，这样才有流水和责任人`
          })
          continue
        }

        const spec = String(item.spec || '').trim()
        const wid = (await resolveWarehouseId(item.warehouse_id)) || (await resolveWarehouseId('peijian'))

        // 导入也必须有仓库权限
        if (!ctx.canAccessWarehouse(wid)) {
          result.failed++
          result.errors.push({ name, error: '没有该仓库的导入权限' })
          continue
        }

        const dup = await queryOne(
          'SELECT id, sub_category FROM materials WHERE name = ? AND spec = ? AND warehouse_id = ? AND is_deleted = 0',
          [name, spec, wid],
          conn
        )
        if (dup) {
          // 已存在：若这次带了细分类而库里还没有，就顺手补上。
          // 用途：后续拿到带「编号 / 车间」的表格时，可以只回填细分类、不重复建料。
          const sub = String(item.sub_category || '').trim()
          if (sub && sub !== String(dup.sub_category || '')) {
            await execute('UPDATE materials SET sub_category = ? WHERE id = ?', [sub, dup.id], conn)
            result.updated++
            continue
          }
          result.skipped++
          continue
        }

        await execute(
          `INSERT INTO materials
             (name, spec, category, sub_category, unit, warehouse_id, current_stock, warning_stock, avg_cost, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, NOW(), NOW())`,
          [
            name, spec, String(item.category || ''), String(item.sub_category || ''),
            String(item.unit || '个'), wid,
            warningStock(item.warning_stock, 10)
          ],
          conn
        )
        result.success++
      } catch (err) {
        result.failed++
        result.errors.push({ name: item.name, error: err.message })
      }
    }
  })

  const msg = `导入完成：新增 ${result.success}，补充细分类 ${result.updated}，跳过重复 ${result.skipped}，失败 ${result.failed}` +
    (result.success ? '（新物料库存为 0，需通过入库单建账）' : '')
  return ok(result, msg)
}

/** 删除物料（软删除，有库存的物料不允许删除） */
async function remove(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '物料 ID 无效')

  const row = await queryOne('SELECT * FROM materials WHERE id = ? AND is_deleted = 0', [id])
  if (!row) return fail(404, '物料不存在')
  ctx.requireWarehouseAccess(row.warehouse_id, '该物料')

  if (num(row.current_stock) !== 0) {
    return fail(400, `该物料当前库存为 ${row.current_stock}，不能删除。请先出库清零或调整库存`)
  }

  const logCount = await queryOne('SELECT COUNT(*) AS c FROM stock_logs WHERE material_id = ?', [id])
  await execute('UPDATE materials SET is_deleted = 1 WHERE id = ?', [id])

  return ok(null, logCount.c > 0
    ? `已停用该物料（历史流水 ${logCount.c} 条予以保留）`
    : '删除成功')
}

/** 取某一列的去重值（带仓库数据权限），供筛选下拉使用 */
async function distinctColumn(ctx, column, requestedWarehouse) {
  const params = []
  let sql = `SELECT DISTINCT m.${column} AS v FROM materials m
              WHERE m.is_deleted = 0 AND m.${column} <> ''`
  const scope = ctx.warehouseScope('m', requestedWarehouse)
  if (scope.sql) {
    sql += ` ${scope.sql}`
    params.push(...scope.params)
  }
  sql += ` ORDER BY m.${column}`
  const rows = await query(sql, params)
  return rows.map((r) => r.v)
}

/**
 * 物料分类列表（供筛选下拉使用）
 *   list          —— 大类（配件 / 成品）
 *   subCategories —— 细分类（成品仓=车间，配件仓=编号类目）
 */
async function categories(ctx, data = {}) {
  const [list, subCategories] = await Promise.all([
    distinctColumn(ctx, 'category', data.warehouse_id),
    distinctColumn(ctx, 'sub_category', data.warehouse_id)
  ])
  return ok({ list, subCategories })
}

module.exports = {
  name: 'material',
  publicActions: [],
  roleRules: {
    upsert: ['boss', 'admin', 'storekeeper'],
    import: ['boss', 'admin'],
    delete: ['boss', 'admin']
  },
  actions: { list, detail, upsert, import: importMaterials, delete: remove, categories }
}
