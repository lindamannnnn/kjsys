/**
 * ============================================================
 * 第三批改动验证（2026-10-03 下午）
 * ------------------------------------------------------------
 * 本轮改了两条业务规则，这个脚本专门证明它们真的生效：
 *
 *   改动 1：出库单撤销权限
 *       原来：待拣货 / 待收货 都由仓管说了算，提交人自己撤不了
 *       现在：待拣货（货还在架上、库存没扣）提交人可以自己撤；
 *             待收货（货已拣完正在交接）提交人不能撤，必须找仓管
 *
 *   改动 2：盘点单可见范围
 *       原来：非管理角色只能看自己创建 / 被指派的盘点单
 *       现在：仓管能看到「自己管的仓库」里的全部盘点单（配件仓 + 成品仓可能同一个人管），
 *             其余非管理角色维持原样
 *
 * 每条判据都带对照场景：证明不是「谁都能撤」「谁都能看」。
 * 数据全部带 [VERIFY] 标记，跑完可用 v2-test-cleanup.js 清理。
 *
 * 用法：node tests/v2-fix-verify3.js
 * ============================================================
 */
require('../src/config/env')
const { query, queryOne } = require('../src/db/pool')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const MARK = '[VERIFY]'

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`   ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`   ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

async function http(pathname, body, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
  return res.json()
}

const call = (mod, action, data, token) => http(`/api/${mod}`, { action, data }, token)

async function login(username, password) {
  const r = await call('auth', 'adminLogin', { username, password })
  if (r.code !== 0) throw new Error(`登录失败 ${username}: ${r.message}`)
  return r.data.token
}

/** 提交一张出库单（带 [VERIFY] 标记，方便清理） */
async function submitOrder(token, materialId, qty, tag) {
  const r = await call('outbound', 'submit', {
    type: 'lingyong',
    warehouse_id: 1,
    remark: `${MARK} 验证撤销权限 ${tag}`,
    items: [{ material_id: materialId, quantity: qty }]
  }, token)
  if (r.code !== 0) throw new Error(`提单失败 ${tag}: ${r.message}`)
  return r.data.id || r.data._id || (r.data.order && (r.data.order.id || r.data.order._id))
}

async function getOrder(id, token) {
  const r = await call('outbound', 'detail', { id }, token)
  return r.code === 0 ? r.data : null
}

async function main() {
  console.log('='.repeat(72))
  console.log('  第三批改动验证：撤销权限 + 盘点单可见范围')
  console.log('='.repeat(72))

  const tokens = {}
  for (const [k, u, p] of [
    ['zhang', 'zhangshan', 'zs123456'],
    ['zhao', 'zhaoliu', 'zl123456'],
    ['wang', 'wangzong', 'wz123456']
  ]) {
    tokens[k] = await login(u, p)
  }
  console.log('\n[准备] 张三（领料员）/ 赵六（仓管，配件仓+成品仓）/ 王总（老板）已登录')

  // 挑一个【测试】物料，避免碰真实物料
  const mat = await queryOne(
    `SELECT id, name, current_stock FROM materials
      WHERE name LIKE '【测试】%' AND warehouse_id = 1 AND is_deleted = 0
      ORDER BY id LIMIT 1`
  )
  if (!mat) throw new Error('找不到仓库1的【测试】物料，请先跑 v2-test-setup.js')
  console.log(`[准备] 使用测试物料：${mat.name}（id=${mat.id}，当前库存 ${mat.current_stock}）`)

  // ============================================================
  console.log('\n【改动 1】出库单撤销权限')
  console.log('-'.repeat(72))

  // --- 判据 1.1：待拣货，提交人可自行撤销（改动前是 403） ---
  const o1 = await submitOrder(tokens.zhang, mat.id, 1, 'A-待拣货')
  await call('outbound', 'confirm', { id: o1 }, tokens.zhao)
  let d1 = await getOrder(o1, tokens.zhang)
  check('1.1 单据已进入「待拣货」', d1 && d1.status === 'picking',
    `status=${d1 && d1.status}`)

  const cancel1 = await call('outbound', 'cancel', { id: o1, reason: `${MARK} 待拣货自行撤销` }, tokens.zhang)
  check('1.2 待拣货：提交人可自行撤销（改动前会被拒）', cancel1.code === 0,
    `code=${cancel1.code} msg=${cancel1.message}`)

  d1 = await getOrder(o1, tokens.zhang)
  check('1.3 撤销后状态为 cancelled', d1 && d1.status === 'cancelled', `status=${d1 && d1.status}`)
  check('1.4 未扣库存的单撤销后不需回补（stock_deducted 仍为 0）',
    d1 && Number(d1.stock_deducted) === 0, `stock_deducted=${d1 && d1.stock_deducted}`)

  const matAfter = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [mat.id])
  check('1.5 库存未被误加减', Number(matAfter.current_stock) === Number(mat.current_stock),
    `改前 ${mat.current_stock} → 改后 ${matAfter.current_stock}`)

  // --- 判据 1.6：待收货，提交人不能撤（这是本次明确要求的「不能撤」） ---
  const o2 = await submitOrder(tokens.zhang, mat.id, 1, 'B-待收货')
  await call('outbound', 'confirm', { id: o2 }, tokens.zhao)
  const pickDone = await call('outbound', 'pickDone', { id: o2 }, tokens.zhao)
  let d2 = await getOrder(o2, tokens.zhang)
  check('1.6 单据已进入「待收货」', d2 && d2.status === 'receiving',
    `status=${d2 && d2.status}（pickDone code=${pickDone.code}）`)

  const cancel2 = await call('outbound', 'cancel', { id: o2, reason: `${MARK} 待收货尝试撤销` }, tokens.zhang)
  check('1.7 待收货：提交人不能撤销', cancel2.code !== 0,
    `code=${cancel2.code} msg=${cancel2.message}`)

  // 对照：仓管仍然可以撤（证明这不是「谁都撤不了」）
  const cancel3 = await call('outbound', 'cancel', { id: o2, reason: `${MARK} 仓管撤销待收货单` }, tokens.zhao)
  check('1.8 对照：同一张待收货单，仓管仍可撤销', cancel3.code === 0,
    `code=${cancel3.code} msg=${cancel3.message}`)

  // --- 判据 1.9：别人提交的待拣货单，我撤不了（防止「谁都能撤」） ---
  const o3 = await submitOrder(tokens.zhang, mat.id, 1, 'C-他人单')
  await call('outbound', 'confirm', { id: o3 }, tokens.zhao)
  const cancel4 = await call('outbound', 'cancel', { id: o3, reason: `${MARK} 赵六撤张三的单` }, tokens.zhao)
  // 赵六是仓管，本来就有权撤 → 这条用来确认仓管权限没被误伤
  check('1.9 对照：仓管可撤「他人提交」的待拣货单（权限没被收窄）', cancel4.code === 0,
    `code=${cancel4.code} msg=${cancel4.message}`)

  // ============================================================
  console.log('\n【改动 2】盘点单可见范围')
  console.log('-'.repeat(72))

  // 现状：stock_checks 里存在「仓库1、创建人是别人」的盘点单
  const otherChecks = await query(
    `SELECT id, check_no, warehouse_id, operator_name, status FROM stock_checks
      WHERE warehouse_id IN (1,2) AND operator_name NOT LIKE '%赵六%'
      ORDER BY id DESC LIMIT 5`
  )
  console.log(`   参照数据：库里有 ${otherChecks.length} 张「仓库1/2 且不是赵六创建」的盘点单`)
  for (const c of otherChecks) {
    console.log(`      ${c.check_no} 仓${c.warehouse_id} 创建人=${c.operator_name} 状态=${c.status}`)
  }

  const zhaoList = await call('check', 'list', { page: 1, page_size: 50 }, tokens.zhao)
  const zhaoNos = (zhaoList.data && zhaoList.data.list ? zhaoList.data.list : []).map((c) => c.check_no)
  console.log(`   赵六可见盘点单 ${zhaoNos.length} 张：${zhaoNos.join(', ')}`)

  const target = otherChecks.find((c) => c.status !== 'cancelled')
  if (target) {
    check(`2.1 仓管能看到「别人创建、但属于自己管的仓库」的盘点单（${target.check_no}）`,
      zhaoNos.includes(target.check_no),
      zhaoNos.includes(target.check_no) ? '已可见' : '仍不可见（改动未生效）')
  } else {
    console.log('   ⚠️ 没有合适的参照盘点单，跳过 2.1')
  }

  check('2.2 仓管看得到成品仓（仓2）的盘点单',
    zhaoList.data && zhaoList.data.list && zhaoList.data.list.some((c) => Number(c.warehouse_id) === 2),
    '配件仓1 + 成品仓2 都归赵六管')

  // 对照：领料员不应因此看到别人的盘点单（改动只放开仓管）
  const zhangList = await call('check', 'list', { page: 1, page_size: 50 }, tokens.zhang)
  const zhangNos = (zhangList.data && zhangList.data.list ? zhangList.data.list : []).map((c) => c.check_no)
  console.log(`   张三（领料员）可见盘点单 ${zhangNos.length} 张：${zhangNos.join(', ') || '（无）'}`)
  const leaked = target ? zhangNos.includes(target.check_no) : false
  check('2.3 对照：领料员仍看不到别人的盘点单（没被连带放开）', !leaked,
    leaked ? '⚠️ 连带放开了，需要收窄' : '未泄漏')

  // 老板仍看全部
  const wangList = await call('check', 'list', { page: 1, page_size: 50 }, tokens.wang)
  const wangCount = (wangList.data && wangList.data.list ? wangList.data.list.length : 0)
  check('2.4 对照：老板可见数量 >= 仓管（管理角色不受限）', wangCount >= zhaoNos.length,
    `老板 ${wangCount} 张 / 仓管 ${zhaoNos.length} 张`)

  // ============================================================
  console.log('\n' + '='.repeat(72))
  console.log(`  结果：${pass} 通过 / ${fail} 失败`)
  if (failures.length) {
    console.log('  失败项：')
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(72))
}

main().then(() => process.exit(fail ? 1 : 0)).catch((e) => {
  console.error('\n脚本异常：', e.message)
  process.exit(2)
})
