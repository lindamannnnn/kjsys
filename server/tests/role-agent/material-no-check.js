/**
 * 成品仓「编号」字段验收（2026-10-11）
 * ============================================================
 * 需求（用户 2026-10-11 原话）：
 *   「成品仓新增物料 添加编号字段；同样规格同样物料 编号不同 需要分开两个数据段；
 *     编号为选填 没填默认是没编号（没编号的是标准产品 有编号的是已经预定出去的产品）」
 *
 * 判重口径（本次改动的核心）：
 *   旧 = 名称 + 规格 + 仓库          唯一
 *   新 = 名称 + 规格 + 编号 + 仓库    唯一
 *   → 同物料同规格、只要编号不同就可各占一条记录；
 *   → 不填编号的只能有一条（不填 = 标准产品）；
 *   → 编号在仓库内仍然唯一（两个物料不能共用一个编号）。
 *
 * 字段复用：沿用既有的 materials.material_no（配件仓也用它存货位编号 A001-7），未加新列。
 *
 * ⚠️ 对照实验（项目铁律）：本脚本对「修复前代码」必须红。
 *   做法：把 src/modules/material.js 里 3 处 `AND material_no = ?`
 *   （新建判重 / 编辑判重 / 导入判重）临时去掉 → 重启 → 重跑。
 *   预期：A3 / A4 / C1 三条「同规格不同编号可并存」失败（被误判成重复），
 *         而 A2 / A5 / A6 / B2 / B3 等"应被拒"的断言仍全绿；恢复代码后全绿。
 *
 * 数据：所有测试物料统一 NO-TEST- 前缀（新建物料库存为 0、无单据引用，直删安全），
 *   跑完在 finally 里清理：物料 + 本轮 operation_logs 审计痕迹。
 */
require('../../src/config/env')
const { callRaw, loginDev, loginAdmin } = require('./lib')
const { query, queryOne, execute } = require('../../src/db/pool')

let pass = 0
let fail = 0
const failures = []

function ok(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` → ${detail}` : ''}`)
  }
}

const PREFIX = 'NO-TEST-'
const NAME_A = `${PREFIX}泵体`
const SPEC_A = 'S1'

async function upsert(token, data) {
  return callRaw('material', 'upsert', data, token)
}

;(async () => {
  console.log('\n═══ 成品仓「编号」字段验收（2026-10-11）═══\n')

  const whGoods = await queryOne(
    "SELECT id, code FROM warehouses WHERE code = 'chengpin' AND is_deleted = 0")
  if (!whGoods) throw new Error('找不到成品仓')
  const wid = whGoods.id

  const token = await loginDev('dev_sk_goods')      // 成品仓管：有 material.upsert
  const admin = await loginAdmin('admin', '123456')  // 批量导入仅 admin

  const createdIds = []

  try {
    // ───────── A. 新建 ─────────
    console.log('A. 新建（成品仓）')

    const a1 = await upsert(token, { name: NAME_A, spec: SPEC_A, warehouse_id: wid, unit: '个' })
    ok('A1 建标准品（不填编号）成功', a1.code === 0, `code=${a1.code} ${a1.message}`)
    if (a1.code === 0) createdIds.push(a1.data._id)

    const a2 = await upsert(token, { name: NAME_A, spec: SPEC_A, warehouse_id: wid, unit: '个' })
    ok('A2 同名同规格再建「不填编号」→ 被拒（标准产品只应有一条）',
      a2.code === 409, `code=${a2.code} ${a2.message}`)

    const a3 = await upsert(token, { name: NAME_A, spec: SPEC_A, material_no: 'YD-001', warehouse_id: wid, unit: '个' })
    ok('A3 同名同规格 + 编号 YD-001 → 成功  ★核心：预定品可与标准品并存',
      a3.code === 0, `code=${a3.code} ${a3.message}`)
    if (a3.code === 0) createdIds.push(a3.data._id)

    const a4 = await upsert(token, { name: NAME_A, spec: SPEC_A, material_no: 'YD-002', warehouse_id: wid, unit: '个' })
    ok('A4 再加编号 YD-002 → 成功  ★核心：同规格可无限按编号区分',
      a4.code === 0, `code=${a4.code} ${a4.message}`)
    if (a4.code === 0) createdIds.push(a4.data._id)

    const a5 = await upsert(token, { name: NAME_A, spec: SPEC_A, material_no: 'YD-001', warehouse_id: wid, unit: '个' })
    ok('A5 同编号 YD-001 重复建 → 被拒', a5.code === 409, `code=${a5.code} ${a5.message}`)

    const a6 = await upsert(token, { name: `${PREFIX}别的料`, spec: 'X9', material_no: 'YD-001', warehouse_id: wid, unit: '个' })
    ok('A6 换个物料名复用 YD-001 → 被拒（编号在仓库内唯一）',
      a6.code === 409, `code=${a6.code} ${a6.message}`)

    const rowsA = await query(
      `SELECT id, material_no FROM materials
        WHERE warehouse_id = ? AND name = ? AND spec = ? AND is_deleted = 0
        ORDER BY material_no`,
      [wid, NAME_A, SPEC_A])
    ok('A7 库中确实并存 3 条（无编号 / YD-001 / YD-002）', rowsA.length === 3,
      `实际 ${rowsA.length} 条：${rowsA.map((r) => `「${r.material_no || '无编号'}」`).join(' ')}`)

    const idStd = (rowsA.find((r) => !r.material_no) || {}).id
    const idNo1 = (rowsA.find((r) => r.material_no === 'YD-001') || {}).id
    const idNo2 = (rowsA.find((r) => r.material_no === 'YD-002') || {}).id

    // ───────── B. 编辑 ─────────
    console.log('\nB. 编辑')

    const b1 = await upsert(token, { _id: idNo2, name: NAME_A, spec: SPEC_A, material_no: 'YD-003', warehouse_id: wid, unit: '个' })
    ok('B1 编号 YD-002 → YD-003 成功', b1.code === 0, `code=${b1.code} ${b1.message}`)

    const b2 = await upsert(token, { _id: idNo2, name: NAME_A, spec: SPEC_A, material_no: 'YD-001', warehouse_id: wid, unit: '个' })
    ok('B2 编号改成已被占用的 YD-001 → 被拒', b2.code === 409, `code=${b2.code} ${b2.message}`)

    const b3 = await upsert(token, { _id: idNo2, name: NAME_A, spec: SPEC_A, material_no: '', warehouse_id: wid, unit: '个' })
    ok('B3 把编号清空 → 与已有标准品冲突，被拒', b3.code === 409, `code=${b3.code} ${b3.message}`)

    const b4 = await upsert(token, { _id: idNo1, name: NAME_A, spec: SPEC_A, warehouse_id: wid, unit: '个', remark: 'no-material-no-param' })
    ok('B4 编辑时「省略」编号参数 → 成功（普通编辑不误清编号）',
      b4.code === 0, `code=${b4.code} ${b4.message}`)
    const dNo1 = await callRaw('material', 'detail', { _id: idNo1 }, token)
    ok('B5 省略编号参数后编号仍在（YD-001）',
      dNo1.code === 0 && dNo1.data.material_no === 'YD-001',
      `实际「${dNo1.data && dNo1.data.material_no}」`)

    const b6 = await upsert(token, { _id: idStd, name: `${NAME_A}改`, spec: SPEC_A, warehouse_id: wid, unit: '个' })
    ok('B6 标准品改名成功（改完仍无编号）', b6.code === 0, `code=${b6.code} ${b6.message}`)

    // ───────── C. 批量导入 ─────────
    console.log('\nC. 批量导入（admin）')

    const c1 = await callRaw('material', 'import', {
      materials: [
        { name: `${PREFIX}导入件`, spec: 'P7', material_no: 'IM-001', warehouse_id: wid, unit: '个' },
        { name: `${PREFIX}导入件`, spec: 'P7', material_no: 'IM-002', warehouse_id: wid, unit: '个' }
      ]
    }, admin)
    ok('C1 导入两条「同物料同规格、不同编号」→ 都新增成功  ★核心',
      c1.code === 0 && c1.data.success === 2, JSON.stringify(c1.data))

    const c2 = await callRaw('material', 'import', {
      materials: [{ name: `${PREFIX}导入件`, spec: 'P7', material_no: 'IM-001', warehouse_id: wid, unit: '个' }]
    }, admin)
    ok('C2 重复导入同编号 → 跳过（不重复建）',
      c2.code === 0 && c2.data.skipped === 1, JSON.stringify(c2.data))

    const c3 = await queryOne(
      `SELECT COUNT(*) AS c FROM materials
        WHERE warehouse_id = ? AND name = ? AND spec = ? AND is_deleted = 0`,
      [wid, `${PREFIX}导入件`, 'P7'])
    ok('C3 导入后库里恰好 2 条（IM-001 / IM-002 各一）', Number(c3.c) === 2, `实际 ${c3.c} 条`)

    // ───────── D. 列表 / 详情 ─────────
    console.log('\nD. 列表与详情')

    const d1 = await callRaw('material', 'list', { keyword: 'YD-001', warehouse_id: wid, page: 1, pageSize: 20 }, token)
    ok('D1 按编号搜索能精确命中',
      d1.code === 0 && (d1.data.list || []).some((x) => x.material_no === 'YD-001'),
      `返回：${JSON.stringify(((d1.data || {}).list || []).map((x) => x.material_no))}`)

    const d2 = await callRaw('material', 'list', { keyword: NAME_A, warehouse_id: wid, page: 1, pageSize: 50 }, token)
    const sameName = ((d2.data || {}).list || []).filter((x) => String(x.name).startsWith(NAME_A))
    ok('D2 列表里同名的多条各自带出编号',
      d2.code === 0 && sameName.length >= 2,
      `返回：${JSON.stringify(sameName.map((x) => `${x.name}/${x.material_no || '无编号'}`))}`)
  } catch (err) {
    fail++
    failures.push(`脚本异常：${err.message}`)
    console.log(`\n  ✗ 脚本异常：${err.stack || err.message}`)
  } finally {
    // ───────── 清理 ─────────
    const ids = createdIds.filter(Boolean)
    const ph = ids.map(() => '?').join(',')
    if (ids.length) {
      await execute(`DELETE FROM materials WHERE name LIKE ? OR id IN (${ph})`,
        [`${PREFIX}%`, ...ids])
    } else {
      await execute('DELETE FROM materials WHERE name LIKE ?', [`${PREFIX}%`])
    }

    // 审计痕迹（operation_logs 里 detail 带测试物料名的那些）
    try {
      await execute("DELETE FROM operation_logs WHERE target_type = 'material' AND detail LIKE ?", [`%${PREFIX}%`])
    } catch (e) {
      console.log(`  (审计日志清理跳过：${e.message})`)
    }

    const left = await queryOne('SELECT COUNT(*) AS c FROM materials WHERE name LIKE ?', [`${PREFIX}%`])
    const cleanOk = Number(left.c) === 0
    if (!cleanOk) { fail++; failures.push('测试物料未清理干净') }
    console.log(`\n  清理：残留测试物料 ${left.c} 条 ${cleanOk ? '✓' : '✗'}`)
  }

  console.log(`\n──────── 结果：${pass}/${pass + fail} 通过，失败 ${fail} ────────`)
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail ? 1 : 0)
})()
