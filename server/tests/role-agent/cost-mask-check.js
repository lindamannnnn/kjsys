/**
 * 成本价 / 库存价值 脱敏验收
 * ============================================================
 * 需求（用户 2026-10-10）：
 *   仓管（成品仓 / 配件仓）的后台物料列表**不再显示**「成本价」「库存价值」。
 *   口径：**仓库端只看数量、不看钱**。
 *
 * 三层验证（缺一不可，这是「越权测试」的标准姿势）：
 *   ① 后端真防线 —— 仓管调 material.list / material.detail，返回里**根本没有 avg_cost**
 *      （前端藏列只是体验，能绕过去就不算数）
 *   ② 放行侧 —— 老板 / 厂长 / 管理员 / 采购员**仍能**拿到 avg_cost
 *      （证明不是"把门整个焊死"，而是精确按角色收）
 *   ③ 回归 —— 领料员依旧连 current_stock 都拿不到（maskStockFields 未被破坏）
 *
 * 另验证导出路径：后台导出走的就是 material.list（forExport:true），
 * 所以仓管导出的 CSV 里也不会夹带成本价。
 *
 * ⚠️ 对照实验（项目铁律）：本脚本对「修复前代码」必须红。
 *   实测 —— 临时把 material.js 里两处 isCostHiddenUser 分支注掉后重跑，结果 **11/16**：
 *   精确红在那 5 条「仓管不可见」断言（列表 ×2 + 详情 ×2 + 导出 ×1），
 *   而放行侧（老板/厂长/采购/管理员）与领料员回归**全部照旧通过** ——
 *   证明判据瞄准的就是本次改动，不是乱红。恢复代码后 16/16。
 *
 * 用法：node tests/role-agent/cost-mask-check.js
 * 依赖：后端已启动（127.0.0.1:3000）、ALLOW_DEV_LOGIN=true、dev_* 账号存在
 * 数据：**只读套件** —— 不写任何业务数据，无需清理
 * ============================================================
 */
require('../../src/config/env')
const { loginDev, loginAdmin, callRaw } = require('./lib')

let pass = 0
let fail = 0
const failures = []

function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅', label)
  } else {
    fail++
    failures.push(label + (detail ? ` :: ${detail}` : ''))
    console.log('  ❌', label, detail)
  }
}

/** 取一组物料的字段情况 */
async function probeList(token) {
  const res = await callRaw('material', 'list', { page: 1, pageSize: 5 }, token)
  if (!res || res.code !== 0) return { error: res && res.message, rows: [] }
  return { rows: (res.data && res.data.list) || [] }
}

/** 取单条物料详情 */
async function probeDetail(token, id) {
  const res = await callRaw('material', 'detail', { id }, token)
  if (!res || res.code !== 0) return { error: res && res.message, row: null }
  return { row: res.data || null }
}

const has = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k)

async function main() {
  console.log('\n═══ 成本价 / 库存价值 脱敏验收 ═══\n')

  const tokens = {}
  for (const [key, openid] of [
    ['配件仓管', 'dev_sk_parts'],
    ['成品仓管', 'dev_sk_goods'],
    ['老板', 'dev_boss'],
    ['厂长', 'dev_director'],
    ['采购员', 'dev_purchase'],
    ['领料员', 'dev_out']
  ]) {
    tokens[key] = await loginDev(openid)
  }
  tokens['管理员'] = await loginAdmin('admin', '123456')

  // ── ① 仓管：拿不到成本价 ────────────────────────────────────
  console.log('[1] 仓管 —— 应当看不到成本价（后端直接不下发）')
  for (const role of ['配件仓管', '成品仓管']) {
    const { rows, error } = await probeList(tokens[role])
    if (error) {
      check(`${role} material.list 可调用`, false, error)
      continue
    }
    check(`${role} material.list 有数据（>=1 条）`, rows.length > 0, `实际 ${rows.length} 条`)
    const anyAvgCost = rows.some((r) => has(r, 'avg_cost'))
    check(`${role} 列表里【没有】avg_cost 字段`, !anyAvgCost,
      anyAvgCost ? `首行字段: ${Object.keys(rows[0] || {}).join(',')}` : '')
    // 数量类字段必须还在（收的是钱，不是数量）
    const keepStock = rows.length > 0 && has(rows[0], 'current_stock')
    check(`${role} 库存数量仍然可见（只收钱不收数量）`, keepStock)

    const id = rows[0] && rows[0]._id
    if (id) {
      const { row, error: e2 } = await probeDetail(tokens[role], id)
      if (e2) {
        check(`${role} material.detail 可调用`, false, e2)
      } else {
        const bad = has(row, 'avg_cost')
        check(`${role} 详情里【没有】avg_cost 字段`, !bad,
          bad ? `字段: ${Object.keys(row || {}).join(',')}` : '')
      }
    }
  }

  // ── ② 放行侧：其他角色照旧能看到 ────────────────────────────
  console.log('\n[2] 非仓管 —— 应当照旧看得到成本价（放行侧对照）')
  for (const role of ['老板', '厂长', '采购员', '管理员']) {
    const { rows, error } = await probeList(tokens[role])
    if (error) {
      check(`${role} material.list 可调用`, false, error)
      continue
    }
    if (!rows.length) {
      check(`${role} 列表有数据`, false, '0 条')
      continue
    }
    // 全部物料已被仓管看过的两仓覆盖；这里拿全局列表首行判断
    const sample = rows.find((r) => has(r, 'avg_cost'))
    check(`${role} 【仍能】拿到 avg_cost 字段`, !!sample,
      sample ? '' : `首行字段: ${Object.keys(rows[0]).join(',')}`)
  }

  // ── ③ 回归：领料员脱敏未被破坏 ──────────────────────────────
  console.log('\n[3] 领料员 —— 回归：连数量都看不到（maskStockFields 未被破坏）')
  {
    const { rows, error } = await probeList(tokens['领料员'])
    if (error) {
      check('领料员 material.list 可调用', false, error)
    } else if (!rows.length) {
      check('领料员 列表有数据', false, '0 条')
    } else {
      const r = rows[0]
      check('领料员 拿不到 current_stock', !has(r, 'current_stock'),
        has(r, 'current_stock') ? `字段: ${Object.keys(r).join(',')}` : '')
      check('领料员 拿不到 avg_cost', !has(r, 'avg_cost'))
    }
  }

  // ── ④ 导出路径：走的就是 material.list ──────────────────────
  console.log('\n[4] 导出路径（前端导出 = material.list + forExport）')
  for (const role of ['成品仓管', '老板']) {
    const res = await callRaw('material', 'list', { page: 1, pageSize: 5, forExport: true }, tokens[role])
    const rows = (res && res.code === 0 && res.data && res.data.list) || []
    const anyCost = rows.some((r) => has(r, 'avg_cost'))
    const shouldHide = role === '成品仓管'
    check(`${role} 导出数据 ${shouldHide ? '不含' : '含'} avg_cost`,
      shouldHide ? !anyCost : anyCost)
  }

  // ── 结果 ────────────────────────────────────────────────────
  console.log('\n───────────────────────────────')
  console.log(`通过 ${pass} / 共 ${pass + fail}`)
  if (fail) {
    console.log('\n失败项：')
    failures.forEach((f) => console.log('  ·', f))
    process.exitCode = 1
  } else {
    console.log('全部通过 ✅')
  }
}

main().catch((err) => {
  console.error('运行异常：', err && err.message)
  process.exitCode = 1
})
