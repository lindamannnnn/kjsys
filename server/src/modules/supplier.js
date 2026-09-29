/**
 * 供应商模块
 */
const { query, queryOne, execute } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, toDbId, paging } = require('../utils/format')

/** 供应商列表 */
async function list(ctx, data = {}) {
  const { keyword = '' } = data
  const { page, pageSize, offset } = paging(data)

  const where = ['is_deleted = 0']
  const params = []

  if (keyword && String(keyword).trim()) {
    const kw = `%${String(keyword).trim()}%`
    where.push('(name LIKE ? OR contact LIKE ? OR phone LIKE ?)')
    params.push(kw, kw, kw)
  }

  const whereSql = where.join(' AND ')
  const cnt = await queryOne(`SELECT COUNT(*) AS total FROM suppliers WHERE ${whereSql}`, params)
  const rows = await query(
    `SELECT * FROM suppliers WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )

  return ok({ list: toApi(rows), total: cnt.total, page, pageSize })
}

/** 供应商详情 */
async function detail(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '供应商 ID 无效')

  const row = await queryOne('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0', [id])
  if (!row) return fail(404, '供应商不存在')
  return ok(toApi(row))
}

/** 新增 / 编辑供应商 */
async function upsert(ctx, data = {}) {
  const { _id, name, contact, phone, address, remark, tax_no: taxNo, payment_terms: paymentTerms } = data
  if (!name || !String(name).trim()) return fail(400, '供应商名称不能为空')

  const cleanName = String(name).trim()

  if (_id) {
    const id = toDbId(_id)
    const exist = await queryOne('SELECT id FROM suppliers WHERE id = ? AND is_deleted = 0', [id])
    if (!exist) return fail(404, '供应商不存在')

    await execute(
      `UPDATE suppliers
          SET name = ?, contact = ?, phone = ?, tax_no = ?, payment_terms = ?, address = ?, remark = ?
        WHERE id = ?`,
      [
        cleanName, String(contact || ''), String(phone || ''),
        String(taxNo || ''), String(paymentTerms || ''),
        String(address || ''), String(remark || ''), id
      ]
    )
    return ok({ _id: id }, '更新成功')
  }

  const dup = await queryOne('SELECT id FROM suppliers WHERE name = ? AND is_deleted = 0', [cleanName])
  if (dup) return fail(409, '该供应商已存在')

  const res = await execute(
    `INSERT INTO suppliers (name, contact, phone, tax_no, payment_terms, address, remark, is_deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
    [
      cleanName, String(contact || ''), String(phone || ''),
      String(taxNo || ''), String(paymentTerms || ''),
      String(address || ''), String(remark || '')
    ]
  )
  return ok({ _id: res.insertId }, '创建成功')
}

/** 删除供应商（软删除） */
async function remove(ctx, data = {}) {
  const id = toDbId(data.id || data._id)
  if (!id) return fail(400, '供应商 ID 无效')

  const used = await queryOne(
    'SELECT COUNT(*) AS c FROM inbound_orders WHERE supplier_id = ? AND is_deleted = 0',
    [id]
  )

  await execute('UPDATE suppliers SET is_deleted = 1 WHERE id = ?', [id])
  return ok(null, used.c > 0 ? `已停用（关联 ${used.c} 张入库单予以保留）` : '删除成功')
}

/**
 * 按关键词模糊搜索（入库时选供应商用）
 * 整改 P2：原来只搜 name，而界面 placeholder 写的是「搜索供应商名称/联系人」，
 *          供应商重名时采购员只能靠联系人区分 → 现在名称/联系人/电话/税号都搜
 */
async function search(ctx, data = {}) {
  const kwRaw = String(data.keyword || '').trim()
  if (!kwRaw) {
    const rows = await query(
      'SELECT * FROM suppliers WHERE is_deleted = 0 ORDER BY name LIMIT 20'
    )
    return ok({ list: toApi(rows) })
  }
  const kw = `%${kwRaw}%`
  const rows = await query(
    `SELECT * FROM suppliers
      WHERE is_deleted = 0
        AND (name LIKE ? OR contact LIKE ? OR phone LIKE ? OR tax_no LIKE ?)
      ORDER BY name LIMIT 20`,
    [kw, kw, kw, kw]
  )
  return ok({ list: toApi(rows) })
}

module.exports = {
  name: 'supplier',
  publicActions: [],
  roleRules: {
    upsert: ['boss', 'admin', 'purchase', 'storekeeper'],
    delete: ['boss', 'admin']
  },
  actions: { list, detail, upsert, delete: remove, search }
}
