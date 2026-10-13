/**
 * 采购任务只针对配件仓 · 后端收口验收（2026-10-12 用户定稿）
 * ============================================================
 * 口径：成品仓存的是成品（车间生产入库），不需要采购；配件仓保留全套采购流程。
 *
 * 断言：
 *   ① 任何人（厂长/成品仓管/管理员）对成品仓物料建采购任务 → 被拒（含「配件仓」提示）
 *   ② 配件仓建采购任务 → 正常（回归保护）
 *   ③ list 只返回配件仓任务（插一条成品仓脏数据，各角色都看不到）
 *   ④ myTodoCount 不统计成品仓任务
 *
 * 对照实验：把 purchase.js 里 isPartsWarehouse 校验与 PARTS_SCOPE_SQL 去掉后，
 *   同一套脚本必须精确跑红（①③④）。
 *
 * 用法：node tests/role-agent/purchase-parts-only-check.js
 * ============================================================
 */
require('../../src/config/env')
const { loginDev, loginAdmin, callRaw } = require('./lib')
const { queryOne, execute } = require('../../src/db/pool')
const { autoCleanup } = require('./_cleanup')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail) }
}

const mark = '[PPO]'

async function main() {
  const admin = await loginAdmin('admin', '123456')
  const skParts = await loginDev('dev_sk_parts')
  const skGoods = await loginDev('dev_sk_goods')
  const director = await loginDev('dev_director')

  // 造测试物料（残留复用：已存在就拿来用）
  async function ensureMat(whId, name, spec) {
    let r = await callRaw('material', 'upsert',
      { name, spec, category: '测试类', unit: '个', warehouse_id: whId, remark: mark }, admin)
    if (r.code === 409) {
      const list = await callRaw('material', 'list', { warehouse_id: whId, keyword: name, page: 1, pageSize: 5 }, admin)
      r = { code: 0, data: { _id: (list.data.list.find((m) => m.name === name))._id } }
    }
    if (r.code !== 0) throw new Error(`造物料失败 ${name}: ${r.message}`)
    return r.data._id
  }
  const matParts = await ensureMat(1, `${mark}配件`, 'PPO-A')
  const matGoods = await ensureMat(2, `${mark}成品`, 'PPO-B')

  console.log('== ① 成品仓不允许建采购任务（核心） ==')
  let r = await callRaw('purchase', 'create',
    { warehouse_id: 2, remark: mark, items: [{ material_id: matGoods, quantity: 1 }] }, director)
  check('厂长建成品仓采购任务被拒', r.code !== 0 && /配件仓/.test(r.message || ''), `code=${r.code} msg=${r.message}`)
  r = await callRaw('purchase', 'create',
    { warehouse_id: 2, remark: mark, items: [{ material_id: matGoods, quantity: 1 }] }, skGoods)
  check('成品仓管建成品仓采购任务被拒', r.code !== 0 && /配件仓/.test(r.message || ''), `code=${r.code} msg=${r.message}`)
  r = await callRaw('purchase', 'create',
    { warehouse_id: 2, remark: mark, items: [{ material_id: matGoods, quantity: 1 }] }, admin)
  check('管理员建成品仓采购任务也被拒（一视同仁）', r.code !== 0 && /配件仓/.test(r.message || ''), `code=${r.code} msg=${r.message}`)

  console.log('== ② 配件仓照常（回归保护） ==')
  r = await callRaw('purchase', 'create',
    { warehouse_id: 1, remark: mark, items: [{ material_id: matParts, quantity: 2 }] }, skParts)
  check('配件仓建采购任务成功', r.code === 0, JSON.stringify(r))
  if (r.code !== 0) throw new Error('配件仓建任务失败，后续无法进行')
  const partsTaskId = r.data._id

  console.log('== ③ list 只返回配件仓任务 ==')
  // 直接插库一条成品仓任务（绕过 create 校验，模拟历史脏数据/绕过入口的情况）
  const dirty = await execute(
    `INSERT INTO purchase_tasks (task_no, warehouse_id, status, creator_openid, creator_name, remark, is_deleted, created_at, updated_at)
     VALUES (?, 2, 'open', 'dev_director', '厂长(测)', ?, 0, NOW(), NOW())`,
    [`PPO-DIRTY-${Date.now()}`, mark])
  const dirtyId = Number(dirty.insertId)

  const idsOf = async (token) => {
    const res = await callRaw('purchase', 'list', { page: 1, pageSize: 100 }, token)
    return ((res.data && res.data.list) || []).map((t) => Number(t._id))
  }
  check('厂长列表不含成品仓任务', !(await idsOf(director)).includes(dirtyId), '')
  check('管理员列表不含成品仓任务', !(await idsOf(admin)).includes(dirtyId), '')
  check('成品仓管列表不含成品仓任务', !(await idsOf(skGoods)).includes(dirtyId), '')
  // 厂长本就在 list 的受众之外（他发完就走，收料是仓管的事）→ 用配件仓管验证配件仓任务正常
  check('配件仓管列表里配件仓任务正常出现', (await idsOf(skParts)).includes(partsTaskId), '')

  console.log('== ④ myTodoCount 不统计成品仓任务 ==')
  // 把脏数据推到「待收料」，如果没过滤，成品仓管的角标会 +1
  await execute(`UPDATE purchase_tasks SET status='purchased' WHERE id=?`, [dirtyId])
  const tcGoods = await callRaw('purchase', 'myTodoCount', {}, skGoods)
  check('成品仓管角标不含成品仓任务', Number(tcGoods.data.total || 0) === 0, JSON.stringify(tcGoods.data))
  // 配件仓管：把配件仓任务也推到「待收料」，角标应该 >=1（回归保护）
  await execute(`UPDATE purchase_tasks SET status='purchased' WHERE id=?`, [partsTaskId])
  const tcParts = await callRaw('purchase', 'myTodoCount', {}, skParts)
  check('配件仓管角标含配件仓任务', Number(tcParts.data.total || 0) >= 1, JSON.stringify(tcParts.data))

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  autoCleanup()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('脚本异常：', e)
  autoCleanup()
  process.exit(1)
})
