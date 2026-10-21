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
const { auditFromCtx } = require('../services/audit')
const { WARNING_COND } = require('../services/warning')
const { isPureOutUser, maskStockFields, isCostHiddenUser, maskCostFields } = require('../middleware/auth')
// 期初建账（2026-10-20）：库存与成本仍然只走库存服务，不做「档案直写」，
// 否则会绕过流水与其他模块的加锁顺序（见 services/stock.js 顶部的并发说明）。
const { lockMaterial, applyChange } = require('../services/stock')

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
  // 与看板/预警页同一套口径（原来这里写的是 `<=`，会把「刚好等于阈值」的料也算成预警）
  if (showWarningOnly) {
    where.push(WARNING_COND)
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

  // 两种脱敏互不冲突：领料员连数量都不给（maskStockFields），仓管只收成本价（maskCostFields）
  if (isPureOutUser(ctx.user)) maskStockFields(rows)
  else if (isCostHiddenUser(ctx.user)) maskCostFields(rows)

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

  if (isPureOutUser(ctx.user)) maskStockFields(row)
  else if (isCostHiddenUser(ctx.user)) maskCostFields(row)

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

  // 仓库必须真实存在（V3 测试 P1-4：原来传 999 也能建出「不属于任何仓库」的孤儿物料）
  const wid = await resolveWarehouseId(warehouseId)
  if (!wid) {
    return fail(
      400,
      warehouseId === undefined || warehouseId === null || warehouseId === ''
        ? '请选择所属仓库'
        : '所选仓库不存在（可能已被删除），请刷新页面后重新选择'
    )
  }
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

    // 编号：不传则保留原值（避免普通编辑把已录入的编号清掉）
    const finalNo =
      materialNo === undefined ? String(exist.material_no || '') : String(materialNo).trim()

    // 判重口径：名称 + 规格 + 编号 三者全同才算重复。
    // 成品仓里「同物料同规格、但编号不同」是两件不同的东西
    // （不填编号 = 标准产品，填了编号 = 已经预定出去的产品），必须能各占一条记录。
    const dup = await queryOne(
      `SELECT id FROM materials
        WHERE name = ? AND spec = ? AND material_no = ? AND warehouse_id = ? AND is_deleted = 0 AND id <> ?`,
      [cleanName, cleanSpec, finalNo, wid, id]
    )
    if (dup) {
      return fail(
        409,
        finalNo
          ? `同仓库下已存在「同名 + 同规格 + 编号 ${finalNo}」的物料，不能重复建档`
          : '同仓库下已存在同名同规格且未填编号的物料（不填编号视为标准产品，只会有一条），不能重复建档'
      )
    }

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
    // 主数据改动留痕（V3 测试 P1-9：原来改物料档案完全不写日志，出事查不到人）
    await auditFromCtx(ctx, {
      action: 'material_update', targetType: 'material', targetId: id,
      detail:
        `修改物料档案「${cleanName}」${cleanSpec ? `（规格 ${cleanSpec}）` : ''}；` +
        `仓库 ${exist.warehouse_id} → ${wid}，预警库存 ${warningStock(warningStockValue, 10)}`
    })
    return ok({ _id: id }, '更新成功（库存与成本不受档案修改影响）')
  }

  // ---------- 新增 ----------
  const finalNo = String(materialNo || '').trim()

  // 判重口径同上：名称 + 规格 + 编号 三者全同才算重复。
  // 这样「同物料同规格、编号不同」可以各建一条；不填编号的只能有一条标准产品。
  const dup = await queryOne(
    `SELECT id, current_stock FROM materials
      WHERE name = ? AND spec = ? AND material_no = ? AND warehouse_id = ? AND is_deleted = 0`,
    [cleanName, cleanSpec, finalNo, wid]
  )
  if (dup) {
    return fail(
      409,
      finalNo
        ? `该仓库已存在「同名 + 同规格 + 编号 ${finalNo}」的物料（当前库存 ${dup.current_stock}），如需修改请直接编辑`
        : `该仓库已存在同名同规格且未填编号的物料（当前库存 ${dup.current_stock}）。`
          + `若这条是已经预定出去的产品，请填写编号以区分；不填编号的只能有一条标准产品`
    )
  }

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

  await auditFromCtx(ctx, {
    action: 'material_create', targetType: 'material', targetId: res.insertId,
    detail: `新建物料「${cleanName}」${cleanSpec ? `（规格 ${cleanSpec}）` : ''}，仓库 ${wid}，初始库存 0`
  })

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

        const no = String(item.material_no || '').trim()

        // 判重口径与 upsert 保持一致：名称 + 规格 + 编号 三者全同才算重复。
        // 这样导入「同物料同规格、编号不同」的预定产品时不会互相顶掉。
        const dup = await queryOne(
          `SELECT id, sub_category FROM materials
            WHERE name = ? AND spec = ? AND material_no = ? AND warehouse_id = ? AND is_deleted = 0`,
          [name, spec, no, wid],
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
             (name, spec, category, sub_category, material_no, unit, warehouse_id, current_stock, warning_stock, avg_cost, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, NOW(), NOW())`,
          [
            name, spec, String(item.category || ''), String(item.sub_category || ''), no,
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

  // 批量导出的影响面比单条大得多，必须留痕（V3 测试 P1-9）
  await auditFromCtx(ctx, {
    action: 'material_import', targetType: 'material',
    detail: `批量导入物料：${msg}` +
      (result.failed ? `；失败项：${result.errors.slice(0, 5).map((e) => e.name).join('、')}` : '')
  })

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

  await auditFromCtx(ctx, {
    action: 'material_delete', targetType: 'material', targetId: id,
    detail: `删除物料「${row.name}」${row.spec ? `（规格 ${row.spec}）` : ''}，仓库 ${row.warehouse_id}，历史流水 ${logCount.c} 条予以保留`
  })

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
 * 成品仓「车间」的固定候选（库里已有的 ∪ 这份列表）
 * ------------------------------------------------------------
 * 车间 = `materials.sub_category`，系统**没有独立字典表**，下拉一直是「从现有物料里 DISTINCT」得来的。
 * 于是有个绕不过去的毛病：**一个还没有任何物料的新车间，筛选和建档时根本选不到** ——
 * 只能先随便建一条物料把它“顶”出来，而那条占位料会混进物料列表、还白占一条库存预警
 * （2026-09-29 就建过「节能炉车间/工程车间/西厨车间」3 条占位物料，后来全被软删了）。
 *
 * 2026-10-21 用户要在「成品仓物料」页加「非标定制车间」→ 改成「已有 ∪ 固定候选」：
 * 新车间立刻可选，又不产生假物料。以后真要加/改车间，只改这里一处。
 *
 * ⚠️ 只对仓库 code = 'chengpin' 生效。
 *   配件仓的 sub_category 是编号类目（A001…），混进来会彻底跑偏。
 */
const CHENG_PIN_WORKSHOPS = ['工程车间', '节能炉车间', '西厨车间', '非标定制车间']

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
  // 大类 → 细分类 映射（建档时选完大类要能看到它下面已有的细分类）
  const params = []
  let mapSql = `SELECT DISTINCT m.category AS c, m.sub_category AS s FROM materials m
                 WHERE m.is_deleted = 0 AND m.category <> '' AND m.sub_category <> ''`
  const scope = ctx.warehouseScope('m', data.warehouse_id)
  if (scope.sql) {
    mapSql += ` ${scope.sql}`
    params.push(...scope.params)
  }
  const pairs = await query(mapSql, params)
  const subMap = {}
  for (const p of pairs) {
    if (!subMap[p.c]) subMap[p.c] = []
    subMap[p.c].push(p.s)
  }
  for (const k of Object.keys(subMap)) subMap[k].sort()

  // ---------- 成品仓：把固定车间候选并进来（理由见 CHENG_PIN_WORKSHOPS 注释） ----------
  const wid = await resolveWarehouseId(data.warehouse_id)
  const wh = wid ? await queryOne('SELECT code FROM warehouses WHERE id = ? AND is_deleted = 0', [wid]) : null
  if (wh && wh.code === 'chengpin') {
    const merged = [...new Set([...subCategories, ...CHENG_PIN_WORKSHOPS])].sort()
    // 成品仓的大类恒为「成品」（一个仓一个大类），直接把候选挂到它下面，
    // 否则建档页选完「成品」大类后，车间下拉会缺这几个还没物料的车间
    const KEY = '成品'
    const existKey = Object.keys(subMap).find((k) => k === KEY) || KEY
    const mergedMap = [...new Set([...(subMap[existKey] || []), ...CHENG_PIN_WORKSHOPS])].sort()
    return ok({ list, subCategories: merged, subMap: { ...subMap, [existKey]: mergedMap } })
  }

  return ok({ list, subCategories, subMap })
}

/* ============================================================
 * 期初建账（2026-10-20 新增）
 * ------------------------------------------------------------
 * 背景：上线后「数量」和「金额」只有客户自己知道（开发者不可能知道），
 *   客户需要对着自己现有的表格，一条条把「数量 + 金额」填进系统。
 *   原来只能走 `scripts/init-stock.js` 填 CSV，老板用不了。
 *
 * 做法：在「编辑物料」页临时开两个可填字段，填完在系统设置里关掉。
 *
 * ⚠️ 三条硬约束（改动前务必先读）：
 *   ① 库存仍然走 `applyChange` 写 `stock_logs`，**绝不允许直接 UPDATE current_stock**，
 *      否则库存流水断链、出事查不到是谁改的。
 *   ② 成本价是「客户直接给定」的，**不做移动加权平均**——期初不是采购，
 *      没有「本次入库单价」这回事，加权只会把数字算歪。
 *   ③ 必须受 `settings.opening_mode` 开关控制，关闭后后端一律拒绝，
 *      前端隐藏只是体验，真正的闸门在 `setOpening` 里。
 * ============================================================ */

/**
 * 谁可以填期初数量/金额
 * ------------------------------------------------------------
 * 口径 = 「谁能打开『编辑物料』页」= `page-matrix.json` 里 /material/edit 的角色，
 *   再对齐「谁能改成本/数量」：
 *     · 入库单（唯一能设成本的动作）= admin / storekeeper
 *     · 盘点调整（能改数量）        = admin / storekeeper / director
 *   取并集 → admin / storekeeper / director。
 *
 * ⚠️ 为什么**不**放 boss：2026-10-09 已按用户要求把「物料档案维护」收归
 *   admin/storekeeper/director，boss 进不了 /material/edit 页。
 *   若这里只给 boss，实际效果是「老板有权限但打不开页面，能用的人反而没权限」。
 *
 * ⚠️ 开关本身（setOpeningMode）仍只给 admin/boss，且 `/setting/company` 仅 admin 可进 ——
 *   即「由管理员开发开关 → 客户填 → 填完管理员关掉」，与用户确认的操作方式一致。
 */
const OPENING_ROLES = ['admin', 'storekeeper', 'director']

/** 读开关（前端据此决定编辑页是否显示这两个字段） */
async function getOpeningMode(ctx) {
  if (!ctx.user) return fail(401, '请先登录')
  const row = await queryOne('SELECT opening_mode FROM settings WHERE id = 1')
  const roles = Array.isArray(ctx.user.roles) ? ctx.user.roles : []
  return ok({
    enabled: Number(row && row.opening_mode) === 1,
    // ⚠️ 必须与下面的 roleRules.setOpening 口径完全一致，否则会出现
    //   「界面显示可填、点了却被拒」这种最难排查的错配
    canEdit: OPENING_ROLES.some((r) => roles.includes(r))
  })
}

/** 开关期初建账模式 */
async function setOpeningMode(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')
  const enabled = data.enabled === true || data.enabled === 1 || data.enabled === '1' ? 1 : 0

  const exists = await queryOne('SELECT id FROM settings WHERE id = 1')
  if (!exists) return fail(400, '系统设置记录不存在（settings 表缺少 id=1 的行）')

  await execute('UPDATE settings SET opening_mode = ? WHERE id = 1', [enabled])
  await auditFromCtx(ctx, {
    action: 'opening_mode',
    targetType: 'setting',
    targetId: 1,
    detail: enabled
      ? '开启「期初建账」录入模式（编辑物料页可填写期初数量与金额）'
      : '关闭「期初建账」录入模式（编辑物料页不再显示期初字段，接口同步拒绝写入）'
  })
  return ok(
    { enabled: !!enabled },
    enabled ? '已开启：现在可以在「编辑物料」里填期初数量与金额' : '已关闭：期初字段已隐藏，接口也会拒绝写入'
  )
}

/**
 * 写期初数量与金额
 * @param {object} data { id, quantity, amount }
 *   quantity —— 实盘数量（>=0，最多 3 位小数）
 *   amount   —— 这批货的总金额（>=0，最多 2 位小数）；单价 = amount / quantity
 *
 * 幂等：重复提交同样的数值 → 库存差值为 0 → 不再写流水，只校正成本。
 */
async function setOpening(ctx, data = {}) {
  if (!ctx.user) return fail(401, '请先登录')

  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '物料 ID 无效')

  const rawQty = data.quantity
  const rawAmount = data.amount === undefined || data.amount === null || data.amount === '' ? 0 : data.amount
  const quantity = Number(rawQty)
  const amount = Number(rawAmount)

  if (!Number.isFinite(quantity) || quantity < 0) return fail(400, '期初数量必须是不小于 0 的数字')
  if (!Number.isFinite(amount) || amount < 0) return fail(400, '期初金额必须是不小于 0 的数字')
  if (quantity > 99999999) return fail(400, '期初数量过大，请核对是否多输了几位')
  if (amount > 999999999) return fail(400, '期初金额过大，请核对是否多输了几位')

  const qty3 = Number(quantity.toFixed(3))
  const amount2 = Number(amount.toFixed(2))

  // 开关闸门：以后端为准，绕过前端也写不进去
  const s = await queryOne('SELECT opening_mode FROM settings WHERE id = 1')
  if (Number(s && s.opening_mode) !== 1) {
    return fail(403, '「期初建账」模式已关闭，不能再修改期初数量与金额。如需修改请先到「系统设置」重新开启')
  }

  const result = await withTransaction(async (conn) => {
    const material = await lockMaterial(conn, id)
    ctx.requireWarehouseAccess(material.warehouse_id, '该物料')

    const before = num(material.current_stock)
    const delta = Number((qty3 - before).toFixed(3))
    const unitPrice = qty3 > 0 ? Number((amount2 / qty3).toFixed(4)) : 0

    if (delta !== 0) {
      await applyChange(conn, {
        material,
        delta,
        changeType: 'opening', // 与 inbound/outbound/check 区分，报表与扫描器据此识别「期初」
        orderNo: '期初建账',
        orderType: 'opening',
        operator: {
          openid: ctx.user.openid || ctx.user.username || '',
          name: ctx.user.real_name || ctx.user.nickname || ctx.user.username || '未知用户'
        },
        remark:
          `期初建账：账 ${before} → 实 ${qty3}，金额 ¥${amount2.toFixed(2)}` +
          (qty3 > 0 ? `（单价 ¥${unitPrice.toFixed(2)}）` : ''),
        // 客户可能先填多了再改小，允许负向调整；结果不会小于 0（quantity 已校验 >= 0）
        allowNegative: true
      })
    }

    // 成本价：直接给定，不做加权平均（理由见本节顶部 ②）
    await execute('UPDATE materials SET avg_cost = ? WHERE id = ?', [unitPrice, id], conn)

    await auditFromCtx(
      ctx,
      {
        action: 'opening_stock',
        targetType: 'material',
        targetId: id,
        detail:
          `期初建账「${material.name}」：数量 ${before} → ${qty3}` +
          `（${delta >= 0 ? '+' : ''}${delta}），金额 ¥${amount2.toFixed(2)}，单价 ¥${unitPrice.toFixed(2)}`
      },
      conn
    )

    return { before, after: qty3, delta, unitPrice, amount: amount2 }
  })

  const msg =
    result.delta === 0
      ? `数量未变（${result.after}），已更新成本价 ¥${result.unitPrice.toFixed(2)}`
      : `已建账：数量 ${result.before} → ${result.after}，单价 ¥${result.unitPrice.toFixed(2)}，金额 ¥${result.amount.toFixed(2)}`
  return ok(result, msg)
}

module.exports = {
  name: 'material',
  publicActions: [],
  roleRules: {
    // 厂长（director）发采购单时会遇到「仓库里还没有的物料」，采购建单页的「＋新增」
    // 要用到这个接口，故一并放行；upsert 已明确拒绝库存/成本字段（见文件头注释），
    // 属于低风险的档案写入，不涉及资损
    // 2026-10-09：老板只读，物料档案维护收回 boss
    upsert: ['admin', 'storekeeper', 'director'],
    import: ['admin'],
    // 删除物料：2026-10-21 按用户要求把权限下放到仓管（原先只有 admin）。
    // ⚠️ 放开的只是「角色门」，下面 remove() 里还有两道硬门，缺一不可：
    //   ① requireWarehouseAccess → 只能删自己管的仓
    //   ② current_stock !== 0 → 直接拒（有库存的物料永远删不掉，必须先出库/盘亏清零）
    //   ③ 软删除（is_deleted=1），历史流水全留 —— 删错了可从库里恢复
    // ⚠️ 厂长仍不给：这是既有设计（见 memory/角色与权限.md），
    //    tests/role-agent/director-check.js 有断言「material.delete 被拒」，别顺手放开。
    delete: ['admin', 'storekeeper'],
    // 期初建账：一次性初始化动作，不属于「日常业务操作」。
    // setOpeningMode 需要 admin/boss（开关只在这两者手上）；
    // setOpening 的口径见文件内 OPENING_ROLES 的注释 —— 必须与 /material/edit 页角色对齐。
    // 两个动作都受 settings.opening_mode 开关约束，关掉即失效。
    setOpeningMode: ['admin', 'boss'],
    setOpening: OPENING_ROLES
  },
  actions: {
    list, detail, upsert, import: importMaterials, delete: remove, categories,
    getOpeningMode, setOpeningMode, setOpening
  }
}
