/**
 * ============================================================
 * 探针：仓管对「物料档案」的增删改 & 登录返回的仓库编码
 * ------------------------------------------------------------
 * 覆盖 2026-10-21 的两处改动：
 *   ① auth 登录 / getUserInfo 返回 warehouse_codes（前端菜单仓库门的唯一依据）
 *      —— 成品仓管必须是 ['chengpin']，不能是 null（null = 不隔离 = 菜单全显示）
 *   ② material.delete 下放到仓管
 *      —— 只能删「自己仓 + 库存为 0」的；别人仓 403、有库存 400
 *
 * 数据安全：
 *   · 只在本地库跑，单据/物料都带 TEST_MARK，结束时全部清理
 *   · 建出来的物料由测试自己删掉，不留残留
 *
 * 用法：node tests/_probe-storekeeper-material.js
 * ============================================================ */
require('../src/config/env')

const http = require('http')
const { signToken } = require('../src/middleware/auth')
const { query, queryOne, execute } = require('../src/db/pool')

const BASE = 'http://127.0.0.1:3000'
const MARK = '【探针·仓管物料权限】'

let pass = 0
let fail = 0
const created = []

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? '  —— ' + extra : ''}`)
  }
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: '127.0.0.1', port: 3000, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try { resolve(JSON.parse(buf)) } catch (e) { resolve({ code: -1, message: buf }) }
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function call(module, action, data, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, data })
    const req = http.request(
      { hostname: '127.0.0.1', port: 3000, path: `/api/${module}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                   Authorization: `Bearer ${token}` } },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try { resolve(JSON.parse(buf)) } catch (e) { resolve({ code: -1, message: buf }) }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  const admin = await queryOne('SELECT * FROM users WHERE id = 1')
  // 按「角色 + 所管仓库」精确挑人：必须**只管一个仓**，否则测不出跨仓拦截
  const holders = await query("SELECT * FROM users WHERE roles LIKE '%storekeeper%' AND status = 'active'")
  const parseIds = (u) => {
    let v = u.warehouse_ids
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch (e) { v = [] } }
    return Array.isArray(v) ? v.map(Number).filter(Boolean) : []
  }
  const skChengpin = holders.find((u) => { const i = parseIds(u); return i.length === 1 && i[0] === 2 })
  const skPeijian = holders.find((u) => { const i = parseIds(u); return i.length === 1 && i[0] === 1 })
  if (!admin || !skChengpin || !skPeijian) {
    throw new Error(`缺少测试账号：admin=${!!admin} 成品仓管=${!!skChengpin} 配件仓管=${!!skPeijian}`)
  }

  const tAdmin = signToken(admin)
  const tC = signToken(skChengpin)
  const tP = signToken(skPeijian)
  console.log(`身份：admin=${admin.real_name} / 成品仓管=${skChengpin.real_name} / 配件仓管=${skPeijian.real_name}\n`)

  // ---------- ① 登录/用户信息返回 warehouse_codes ----------
  console.log('== 1. 登录返回的仓库编码（前端菜单仓库门的依据）==')
  const infoAdmin = await call('auth', 'getUserInfo', {}, tAdmin)
  const infoC = await call('auth', 'getUserInfo', {}, tC)
  const infoP = await call('auth', 'getUserInfo', {}, tP)

  check('admin 的 warehouse_codes = null（不隔离）',
    infoAdmin.data && infoAdmin.data.warehouse_codes === null,
    JSON.stringify(infoAdmin.data && infoAdmin.data.warehouse_codes))
  check('成品仓管 的 warehouse_codes = ["chengpin"]',
    JSON.stringify(infoC.data && infoC.data.warehouse_codes) === '["chengpin"]',
    JSON.stringify(infoC.data && infoC.data.warehouse_codes))
  check('配件仓管 的 warehouse_codes = ["peijian"]',
    JSON.stringify(infoP.data && infoP.data.warehouse_codes) === '["peijian"]',
    JSON.stringify(infoP.data && infoP.data.warehouse_codes))

  // ---------- ② 删除：自己仓 + 库存 0 ----------
  console.log('\n== 2. 删除：自己仓 + 库存 0 → 应放行 ==')
  const mk = await call('material', 'upsert', {
    name: MARK + '待删物料',
    spec: 'TEST-SPEC',
    category: '成品',
    sub_category: '工程车间',
    unit: '台',
    warehouse_id: 2,
    warning_stock: 0
  }, tAdmin)
  check('admin 建测试物料', mk.code === 0, mk.message)
  const newId = mk.data && mk.data._id
  if (newId) created.push(newId)

  const before = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [newId])
  check('新物料库存为 0', Number(before.current_stock) === 0, String(before.current_stock))

  const del = await call('material', 'delete', { id: newId }, tC)
  check('成品仓管删除自己仓的 0 库存物料 → 成功', del.code === 0, `${del.code} ${del.message}`)
  const after = await queryOne('SELECT is_deleted FROM materials WHERE id = ?', [newId])
  check('删除是软删（is_deleted=1，记录还在）', Number(after && after.is_deleted) === 1, JSON.stringify(after))

  // ---------- ③ 删除：跨仓 → 403 ----------
  console.log('\n== 3. 删除：别的仓 → 应 403 ==')
  const mk2 = await call('material', 'upsert', {
    name: MARK + '跨仓物料',
    spec: 'TEST-SPEC-2',
    category: '成品',
    sub_category: '工程车间',
    unit: '台',
    warehouse_id: 2,
    warning_stock: 0
  }, tAdmin)
  const id2 = mk2.data && mk2.data._id
  if (id2) created.push(id2)
  const delCross = await call('material', 'delete', { id: id2 }, tP)
  check('配件仓管删成品仓物料 → 403', delCross.code === 403, `${delCross.code} ${delCross.message}`)

  // ---------- ④ 删除：有库存 → 400 ----------
  console.log('\n== 4. 删除：有库存 → 应 400（先出库清零才能删）==')
  const withStock = await queryOne(
    'SELECT id, current_stock FROM materials WHERE warehouse_id = 2 AND is_deleted = 0 AND current_stock > 0 LIMIT 1'
  )
  if (withStock) {
    const delStock = await call('material', 'delete', { id: withStock.id }, tC)
    check(`成品仓管删「库存 ${withStock.current_stock}」的物料 → 400`,
      delStock.code === 400, `${delStock.code} ${delStock.message}`)
  } else {
    console.log('  （跳过）本地成品仓没有库存 > 0 的物料，无法验证这一条')
  }

  // ---------- ⑤ 厂长仍不能删 ----------
  console.log('\n== 5. 厂长仍然不能删（既有设计，未放开）==')
  const director = await queryOne("SELECT * FROM users WHERE roles LIKE '%director%' AND status='active' LIMIT 1")
  if (director && id2) {
    const tD = signToken(director)
    const delD = await call('material', 'delete', { id: id2 }, tD)
    check('厂长删物料 → 403', delD.code === 403, `${delD.code} ${delD.message}`)
  } else {
    console.log('  （跳过）本地没有厂长账号')
  }
}

async function cleanup() {
  if (!created.length) return
  const ph = created.map(() => '?').join(',')
  await execute(`UPDATE materials SET is_deleted = 1 WHERE id IN (${ph})`, created)
  const left = await queryOne(
    `SELECT COUNT(*) c FROM materials WHERE id IN (${ph}) AND is_deleted = 0`, created
  )
  console.log(`\n清理：${created.length} 条测试物料已软删（残留 ${left.c} 条）`)
}

main()
  .then(async () => {
    await cleanup()
    console.log(`\n========== 结果：通过 ${pass} / 失败 ${fail} ==========`)
    process.exit(fail ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('\n探针异常：', e.message)
    await cleanup()
    process.exit(1)
  })
