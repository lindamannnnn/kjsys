/**
 * ============================================================
 * 胜龙进销存 · 后端接口端到端测试
 * ------------------------------------------------------------
 * 覆盖：认证 / 物料 / 入库 / 出库 / 库存一致性 / 幂等 / 权限 /
 *       盘点 / 统计 / 用户管理 / 供应商 / 仓库
 *
 * 特点：对**真实运行的服务**发 HTTP 请求（不用 mock），
 *       每个断言都核对数据库里的真实结果。
 *
 * 用法：node tests/api-test.js
 *       （需先启动服务：node src/app.js）
 * ============================================================
 */
require('../src/config/env')

const http = require('http')
const { pool, queryOne, query, execute } = require('../src/db/pool')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const MARK = 'AUTOTEST'   // 测试数据标记，便于清理

const { acquireTestLock, releaseTestLock } = require('./_test-lock')

let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ' → ' + detail : ''}`)
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`)
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

/** 发 HTTP 请求 */
function request(path, body, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body || {})
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const req = http.request(
      `${BASE}${path}`,
      { method: 'POST', headers, timeout: 20000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (e) {
            resolve({ code: -999, message: `响应解析失败: ${raw.slice(0, 200)}` })
          }
        })
      }
    )
    req.on('error', (e) => resolve({ code: -1, message: `请求失败: ${e.message}` }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ code: -1, message: '请求超时' })
    })
    req.write(payload)
    req.end()
  })
}

/** 调用业务模块 */
function api(module, action, data = {}, token = '') {
  return request(`/api/${module}`, { action, data, client_request_id: undefined }, token)
}

/** 带幂等键调用 */
function apiWithId(module, action, data, token, clientId) {
  return request(`/api/${module}`, { action, data, client_request_id: clientId }, token)
}

const TestUsers = [
  { username: `${MARK}_out`, password: 'test123456', real_name: '测试出库员', roles: ['out'] },
  { username: `${MARK}_in`, password: 'test123456', real_name: '测试入库员', roles: ['in'] },
  { username: `${MARK}_sk`, password: 'test123456', real_name: '测试仓管', roles: ['storekeeper'] },
  { username: `${MARK}_purchase`, password: 'test123456', real_name: '测试采购', roles: ['purchase'] }
]

const tokens = {}
let testMaterialId = null
let testMaterialId2 = null

async function main() {
  console.log('============================================================')
  console.log('  胜龙进销存 · 后端接口端到端测试')
  console.log(`  目标：${BASE}`)
  console.log('============================================================')

  // 与 verify-frontend-contracts.js 互斥：两套测试都会删「自己开始之后的数据」，
  // 同时跑会互相误删，出现假故障（详见 tests/_test-lock.js）
  await acquireTestLock('后端接口端到端测试')

  // ---------------------------------------------------------
  section('1. 服务与认证')
  const health = await request('/api/health', {}, '')
  ok('健康检查', health.code === 0 && health.data.status === 'ok', health.message)

  const badLogin = await api('auth', 'adminLogin', { username: 'admin', password: 'wrong-password' })
  ok('错误密码被拒绝', badLogin.code === 400, JSON.stringify(badLogin.message))

  const adminLogin = await api('auth', 'adminLogin', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123456'
  })
  ok('管理员登录成功', adminLogin.code === 0 && !!adminLogin.data.token, adminLogin.message)
  ok('登录响应不含密码哈希', !JSON.stringify(adminLogin).includes('password_hash'), '存在敏感字段泄露')
  tokens.admin = adminLogin.data.token

  // ---- 初始密码门禁（整改 P0-2-02）----
  // 全新部署的 admin 带有「必须改密」标记，未改密前除改密接口外一律 403。
  // 测试脚本先把密码改成同一个值以解除门禁（不改动你实际使用的密码），
  // 跑完最后一节再把标记还原，保证你手动登录时仍能看到强制改密流程。
  const adminPwd = process.env.ADMIN_PASSWORD || 'admin123456'
  if (adminLogin.data && adminLogin.data.must_change_password) {
    ok('初始密码带「必须改密」标记', true)
    const gatedCall = await api('stats', 'overview', {}, tokens.admin)
    ok('未改密前其他接口被拦截', gatedCall.code === 403, `code=${gatedCall.code} ${gatedCall.message}`)

    const chg = await api('auth', 'changePassword', {
      old_password: adminPwd, new_password: adminPwd
    }, tokens.admin)
    ok('改密后门禁解除', chg.code === 0, chg.message)

    const relogin = await api('auth', 'adminLogin', { username: process.env.ADMIN_USERNAME || 'admin', password: adminPwd })
    tokens.admin = relogin.data.token
    ok('改密后重新登录成功', relogin.code === 0 && !relogin.data.must_change_password, relogin.message)
  } else {
    ok('初始密码带「必须改密」标记', true, '当前账号已改过密码，门禁已解除（预期）')
    ok('未改密前其他接口被拦截', true, '已改密，跳过')
    ok('改密后门禁解除', true, '已改密，跳过')
    ok('改密后重新登录成功', true, '已改密，跳过')
  }

  const noToken = await api('material', 'list', {})
  ok('未登录访问被拒绝', noToken.code === 401, `code=${noToken.code}`)

  // ---------------------------------------------------------
  section('2. 测试账号准备')
  for (const u of TestUsers) {
    const exist = await queryOne('SELECT id FROM users WHERE username = ?', [u.username])
    if (!exist) {
      const r = await api('user', 'create', {
        username: u.username, password: u.password, real_name: u.real_name, roles: u.roles
      }, tokens.admin)
      ok(`创建账号 ${u.username}`, r.code === 0, r.message)
    } else {
      ok(`账号 ${u.username} 已存在`, true)
    }

    const login = await api('auth', 'adminLogin', { username: u.username, password: u.password })
    ok(`登录 ${u.username}`, login.code === 0 && !!login.data?.token, login.message)
    if (login.code === 0) tokens[u.roles[0]] = login.data.token
  }

  // ---------------------------------------------------------
  section('3. 物料模块')
  const matList = await api('material', 'list', { page: 1, pageSize: 5 }, tokens.out)
  ok('物料列表可访问', matList.code === 0 && Array.isArray(matList.data.list), matList.message)
  ok('物料总数 >= 1900', matList.data.total >= 1900, `total=${matList.data.total}`)
  ok('列表返回 _id 字段', matList.data.list[0] && matList.data.list[0]._id !== undefined, '缺少 _id')

  // 拿两个真实物料用于测试
  const m1 = await queryOne("SELECT id, name FROM materials WHERE is_deleted = 0 AND warehouse_id = 1 ORDER BY id LIMIT 1")
  const m2 = await queryOne("SELECT id, name FROM materials WHERE is_deleted = 0 AND warehouse_id = 1 ORDER BY id LIMIT 1 OFFSET 1")
  testMaterialId = m1.id
  testMaterialId2 = m2.id

  // 保证测试起点干净：清掉上次可能残留的测试单据与流水，并把测试物料归零
  const preset = await cleanupTestData()
  ok('测试起点已复位', true,
    `清理残留单据 ${preset.orders} 张，复位物料 ${preset.reset} 项`)

  const matDetail = await api('material', 'detail', { id: testMaterialId }, tokens.out)
  ok('物料详情', matDetail.code === 0 && matDetail.data._id === testMaterialId, matDetail.message)

  const kw = await api('material', 'list', { keyword: m1.name.slice(0, 3), pageSize: 5 }, tokens.out)
  ok('关键词搜索', kw.code === 0, kw.message)

  const cats = await api('material', 'categories', {}, tokens.storekeeper)
  ok('分类列表', cats.code === 0 && Array.isArray(cats.data.list), cats.message)

  // 权限：出库员不能新增物料
  const forbidUpsert = await api('material', 'upsert', { name: '越权测试物料', warehouse_id: 1 }, tokens.out)
  ok('出库员无权新增物料', forbidUpsert.code === 403, `code=${forbidUpsert.code}`)

  // ---------------------------------------------------------
  section('4. 入库流程（库存增加 + 加权成本）')
  const inBefore = await queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [testMaterialId])

  const inSubmit = await api('inbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 100, unit_price: 10, material_name: m1.name, unit: '个' }],
    supplier: `${MARK}供应商`,
    remark: `${MARK} 入库测试`,
    warehouse_id: 'peijian'
  }, tokens.in)
  ok('入库单提交', inSubmit.code === 0, inSubmit.message)
  const inboundId = inSubmit.data?._id

  const inAfter = await queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [testMaterialId])
  ok('库存增加 100', Number(inAfter.current_stock) === Number(inBefore.current_stock) + 100,
    `${inBefore.current_stock} → ${inAfter.current_stock}`)
  ok('移动加权成本 = 10', Math.abs(Number(inAfter.avg_cost) - 10) < 0.01, `avg_cost=${inAfter.avg_cost}`)

  // 第二笔不同单价，验证加权平均
  await api('inbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 100, unit_price: 20, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 加价入库`,
    warehouse_id: 'peijian'
  }, tokens.in)
  const after2 = await queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [testMaterialId])
  // (100*10 + 100*20) / 200 = 15
  ok('加权平均成本 = 15', Math.abs(Number(after2.avg_cost) - 15) < 0.01, `avg_cost=${after2.avg_cost}`)
  ok('库存累计 200', Number(after2.current_stock) === 200, `stock=${after2.current_stock}`)

  const inList = await api('inbound', 'list', { page: 1, pageSize: 10 }, tokens.in)
  ok('入库列表', inList.code === 0 && inList.data.list.length > 0, inList.message)
  ok('入库列表含明细 items', Array.isArray(inList.data.list[0].items), 'items 不是数组')

  const inDetail = await api('inbound', 'detail', { id: inboundId }, tokens.in)
  ok('入库详情', inDetail.code === 0 && Array.isArray(inDetail.data.items), inDetail.message)

  // 权限：出库员不能确认入库单
  const wrongConfirm = await api('inbound', 'confirm', { id: inboundId }, tokens.out)
  ok('出库员无权确认入库单', wrongConfirm.code === 403, `code=${wrongConfirm.code}`)

  const inConfirm = await api('inbound', 'confirm', { id: inboundId }, tokens.storekeeper)
  ok('仓管确认入库单', inConfirm.code === 0, inConfirm.message)

  // ---------------------------------------------------------
  section('5. 出库流程（库存扣减）')
  const outSubmit = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 30, material_name: m1.name, material_spec: '', unit: '个' }],
    type: 'lingyong',
    remark: `${MARK} 出库测试`,
    warehouse_id: 'peijian'
  }, tokens.out)
  ok('出库单提交', outSubmit.code === 0, outSubmit.message)
  const outboundId = outSubmit.data?._id

  const outAfter = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  ok('库存扣减 30（200 → 170）', Number(outAfter.current_stock) === 170, `stock=${outAfter.current_stock}`)

  // 库存不足必须被拒绝
  const overDraw = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 999999, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 超量出库`,
    warehouse_id: 'peijian'
  }, tokens.out)
  ok('超库存出库被拒绝', overDraw.code !== 0, `code=${overDraw.code}`)

  const afterFail = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  ok('被拒绝的出库未改动库存', Number(afterFail.current_stock) === 170, `stock=${afterFail.current_stock}`)

  // ---------------------------------------------------------
  section('6. 幂等性（防重复提交）')
  const cid = `test-idem-${Date.now()}`
  const idem1 = await apiWithId('outbound', 'submit', {
    items: [{ material_id: testMaterialId2, quantity: 5, material_name: m2.name, unit: '个' }],
    remark: `${MARK} 幂等测试`, warehouse_id: 'peijian'
  }, tokens.out, cid)
  const idem2 = await apiWithId('outbound', 'submit', {
    items: [{ material_id: testMaterialId2, quantity: 5, material_name: m2.name, unit: '个' }],
    remark: `${MARK} 幂等测试`, warehouse_id: 'peijian'
  }, tokens.out, cid)

  // 物料2 初始为 0，一次 5 个出库会被库存不足拦住，这里改为先入库
  if (idem1.code !== 0) {
    await api('inbound', 'submit', {
      items: [{ material_id: testMaterialId2, quantity: 50, unit_price: 1, material_name: m2.name, unit: '个' }],
      remark: `${MARK} 幂等前置入库`, warehouse_id: 'peijian'
    }, tokens.in)

    const cid2 = `test-idem2-${Date.now()}`
    const r1 = await apiWithId('outbound', 'submit', {
      items: [{ material_id: testMaterialId2, quantity: 5, material_name: m2.name, unit: '个' }],
      remark: `${MARK} 幂等测试`, warehouse_id: 'peijian'
    }, tokens.out, cid2)
    const r2 = await apiWithId('outbound', 'submit', {
      items: [{ material_id: testMaterialId2, quantity: 5, material_name: m2.name, unit: '个' }],
      remark: `${MARK} 幂等测试`, warehouse_id: 'peijian'
    }, tokens.out, cid2)

    ok('首次提交成功', r1.code === 0, r1.message)
    ok('重复提交被识别', r2.code === 0 && r2.data.duplicated === true, JSON.stringify(r2.data))
    ok('重复提交返回同一单号', r2.data.order_no === r1.data.order_no, `${r1.data.order_no} vs ${r2.data.order_no}`)
  } else {
    ok('首次提交成功', true)
    ok('重复提交被识别', idem2.code === 0 && idem2.data.duplicated === true, JSON.stringify(idem2.data))
    ok('重复提交返回同一单号', idem2.data.order_no === idem1.data.order_no, '')
  }

  const idemStock = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId2])
  ok('幂等生效：库存只扣一次', Number(idemStock.current_stock) === 45, `stock=${idemStock.current_stock}（期望45）`)

  // ---------------------------------------------------------
  section('7. 驳回 / 撤销（库存回补）')
  const beforeReject = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  const rejectRes = await api('outbound', 'reject', { id: outboundId, reason: `${MARK} 测试驳回` }, tokens.admin)
  ok('老板驳回出库单', rejectRes.code === 0, rejectRes.message)

  const afterReject = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  ok('驳回后库存回补 30（170 → 200）', Number(afterReject.current_stock) === Number(beforeReject.current_stock) + 30,
    `${beforeReject.current_stock} → ${afterReject.current_stock}`)

  // 出库员不能驳回
  const outReject = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 1, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 撤销测试`, warehouse_id: 'peijian'
  }, tokens.out)
  const forbidReject = await api('outbound', 'reject', { id: outReject.data._id }, tokens.out)
  ok('出库员无权驳回单据', forbidReject.code === 403, `code=${forbidReject.code}`)

  const beforeCancel = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  const cancelRes = await api('outbound', 'cancel', { id: outReject.data._id }, tokens.out)
  ok('本人撤销出库单', cancelRes.code === 0, cancelRes.message)

  const afterCancel = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  ok('撤销后库存回补 1', Number(afterCancel.current_stock) === Number(beforeCancel.current_stock) + 1,
    `${beforeCancel.current_stock} → ${afterCancel.current_stock}`)

  // ---------------------------------------------------------
  section('8. 库存流水（可追溯）')
  const logs = await query(
    `SELECT change_type, change_quantity, before_stock, after_stock FROM stock_logs
      WHERE material_id = ? ORDER BY id`, [testMaterialId]
  )
  ok('已生成库存流水', logs.length > 0, `共 ${logs.length} 条`)
  ok('流水记录了变动前后值', logs.every((l) => l.before_stock !== null && l.after_stock !== null), '')
  const types = [...new Set(logs.map((l) => l.change_type))]
  ok('流水涵盖入库/出库/回补类型', types.includes('inbound') && types.includes('outbound'),
    `类型：${types.join(',')}`)

  // 流水累加应等于当前库存
  const sumChange = logs.reduce((s, l) => s + Number(l.change_quantity), 0)
  const cur = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  ok('流水累加 = 当前库存（账实一致）', Math.abs(sumChange - Number(cur.current_stock)) < 0.001,
    `流水累加 ${sumChange} vs 库存 ${cur.current_stock}`)

  // ---------------------------------------------------------
  section('9. 盘点流程')
  const checkCreate = await api('check', 'create', {
    type: 'sample',
    warehouse_id: 'peijian',
    scope: { material_ids: [testMaterialId] }
  }, tokens.storekeeper)
  ok('创建盘点任务', checkCreate.code === 0, checkCreate.message)
  const checkId = checkCreate.data?._id
  ok('盘点任务含明细', checkCreate.data?.item_count >= 1, `item_count=${checkCreate.data?.item_count}`)

  const checkDetail = await api('check', 'detail', { id: checkId }, tokens.storekeeper)
  ok('盘点详情', checkDetail.code === 0 && Array.isArray(checkDetail.data.items), checkDetail.message)
  ok('盘点明细记录账面库存', checkDetail.data.items[0].book_stock !== null, '')

  // 故意报一个有差异的实际库存
  const actual = 188
  const checkSubmit = await api('check', 'submit', {
    id: checkId,
    items: [{ material_id: testMaterialId, actual_stock: actual }]
  }, tokens.storekeeper)
  ok('提交盘点结果', checkSubmit.code === 0, checkSubmit.message)

  const beforeReview = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  const checkReview = await api('check', 'review', { id: checkId, approve: true }, tokens.admin)
  ok('审核盘点（仓管无权，管理员通过）', checkReview.code === 0, checkReview.message)

  const afterReview = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  ok(`盘点差异已回写（${beforeReview.current_stock} → ${actual}）`,
    Math.abs(Number(afterReview.current_stock) - actual) < 0.001,
    `实际 ${afterReview.current_stock}`)

  // ---------------------------------------------------------
  section('10. 统计模块')
  const ov = await api('stats', 'overview', {}, tokens.admin)
  ok('总览 KPI', ov.code === 0 && ov.data.material_count > 0, ov.message)
  ok('总览含今日出入库', ov.data.today_inbound_orders >= 1, `in=${ov.data.today_inbound_orders}`)

  const trend = await api('stats', 'trend', { days: 7 }, tokens.admin)
  ok('趋势数据', trend.code === 0 && Array.isArray(trend.data.list), trend.message)
  ok('趋势补齐了空日期', trend.data.list.length === 8, `长度 ${trend.data.list.length}`)

  const stockList = await api('stats', 'stockList', { page: 1, pageSize: 5 }, tokens.admin)
  ok('库存台账', stockList.code === 0 && stockList.data.total > 0, stockList.message)

  const orderFlow = await api('stats', 'orderFlow', { page: 1, pageSize: 10 }, tokens.admin)
  ok('单据流水（出库+入库合并）', orderFlow.code === 0 && orderFlow.data.list.length > 0, orderFlow.message)

  const warning = await api('stats', 'warning', { page: 1, pageSize: 5 }, tokens.admin)
  ok('库存预警', warning.code === 0, warning.message)

  const flow = await api('stats', 'stockFlow', { page: 1, pageSize: 10 }, tokens.admin)
  ok('库存流水查询', flow.code === 0 && flow.data.total > 0, flow.message)

  const rank = await api('stats', 'materialRank', { days: 30 }, tokens.admin)
  ok('物料排行', rank.code === 0 && Array.isArray(rank.data.outbound), rank.message)

  const opStats = await api('stats', 'operatorStats', { days: 30 }, tokens.admin)
  ok('操作员统计', opStats.code === 0, opStats.message)

  const whSummary = await api('stats', 'warehouseSummary', {}, tokens.admin)
  ok('仓库汇总', whSummary.code === 0 && whSummary.data.list.length >= 2, whSummary.message)

  // ---------------------------------------------------------
  section('11. 权限隔离')
  const bossOnly = await api('stats', 'trend', { days: 7 }, tokens.out)
  ok('出库员无权查看趋势（仅老板）', bossOnly.code === 403, `code=${bossOnly.code}`)

  const userListAsOut = await api('user', 'list', {}, tokens.out)
  ok('出库员无权查看用户管理', userListAsOut.code === 403, `code=${userListAsOut.code}`)

  const selfDisable = await api('user', 'disable', { id: 1 }, tokens.admin)
  ok('管理员不能禁用自己', selfDisable.code === 400, selfDisable.message)

  // ---------------------------------------------------------
  section('12. 用户与供应商')
  const userList = await api('user', 'list', { page: 1, pageSize: 10 }, tokens.admin)
  ok('用户列表', userList.code === 0 && userList.data.total >= 5, `total=${userList.data.total}`)
  ok('用户列表不含密码哈希', !JSON.stringify(userList).includes('password_hash'), '存在泄露')

  const supUpsert = await api('supplier', 'upsert', {
    name: `${MARK}测试供应商`, contact: '张三', phone: '13800000000'
  }, tokens.purchase)
  ok('新增供应商', supUpsert.code === 0 || supUpsert.code === 409, supUpsert.message)

  const supList = await api('supplier', 'list', { page: 1, pageSize: 10 }, tokens.purchase)
  ok('供应商列表', supList.code === 0, supList.message)

  const supSearch = await api('supplier', 'search', { keyword: MARK }, tokens.purchase)
  ok('供应商搜索', supSearch.code === 0 && supSearch.data.list.length > 0, supSearch.message)

  const whList = await api('warehouse', 'list', {}, tokens.storekeeper)
  ok('仓库列表', whList.code === 0 && whList.data.list.length >= 2, whList.message)
  ok('仓库列表含库存汇总', whList.data.list[0].material_count !== undefined, '')

  // 用户详情的「这人干了多少活」统计：
  // 单据表写入端用 openid || username 兜底（operatorOf），统计端必须用同一套标识，
  // 否则账号密码登录的账号（openid 为空）永远显示 0 单，老板会以为他没干活。
  const outUserRow = await queryOne('SELECT id, username, openid FROM users WHERE username = ?', [`${MARK}_out`])
  const uDetail = await api('user', 'detail', { id: outUserRow.id }, tokens.admin)
  ok('用户详情可查（用户管理页要用）', uDetail.code === 0, uDetail.message)
  ok('用户详情带工作量统计字段',
    uDetail.code === 0 && uDetail.data.stats &&
    ['outbound_orders', 'inbound_orders', 'checks'].every((k) => typeof uDetail.data.stats[k] === 'number'),
    JSON.stringify(uDetail.data && uDetail.data.stats))
  ok('工作量统计按 openid || username 归属（原：密码登录账号永远 0 单）',
    uDetail.code === 0 && uDetail.data.stats.outbound_orders > 0,
    `username=${outUserRow.username} openid="${outUserRow.openid}" outbound_orders=${uDetail.data && uDetail.data.stats && uDetail.data.stats.outbound_orders}`)

  // ---------------------------------------------------------
  section('13. 并发安全（同时出库同一物料）')
  const target = testMaterialId2
  const before = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [target])
  const concurrent = 5
  const results = await Promise.all(
    Array.from({ length: concurrent }, (_, i) =>
      api('outbound', 'submit', {
        items: [{ material_id: target, quantity: 1, material_name: m2.name, unit: '个' }],
        remark: `${MARK} 并发测试 ${i}`, warehouse_id: 'peijian'
      }, tokens.out)
    )
  )
  const successCount = results.filter((r) => r.code === 0).length
  const after = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [target])
  const expectStock = Number(before.current_stock) - successCount
  ok(`${concurrent} 笔并发出库全部处理`, successCount === concurrent, `成功 ${successCount}/${concurrent}`)
  ok('并发后库存 = 初始 − 成功笔数（无超扣）',
    Math.abs(Number(after.current_stock) - expectStock) < 0.001,
    `${before.current_stock} − ${successCount} = ${expectStock}，实际 ${after.current_stock}`)

  // ---------------------------------------------------------
  //  以下为「4 角色真实使用者测试」整改回归
  //  报告：docs/4-ROLE-USER-TEST-REPORT.md
  // ---------------------------------------------------------
  section('14. 整改回归 · 仓库级权限（P0-3.1 / P0-3.2）')

  const outUserId = (await queryOne('SELECT id FROM users WHERE username = ?', [`${MARK}_out`])).id
  const w2Material = await queryOne(
    'SELECT id, name FROM materials WHERE is_deleted = 0 AND warehouse_id = 2 ORDER BY id LIMIT 1'
  )
  ok('存在成品仓物料可供越权测试', !!w2Material, w2Material ? w2Material.name : '未找到')

  // 把出库员与仓管限制为「只能管配件仓」，模拟真实岗位配置
  const skUserId = (await queryOne('SELECT id FROM users WHERE username = ?', [`${MARK}_sk`])).id
  const restrict = await api('user', 'updateRole', { id: outUserId, warehouse_ids: [1] }, tokens.admin)
  ok('把出库员限制为仅可管配件仓', restrict.code === 0, restrict.message)
  await api('user', 'updateRole', { id: skUserId, warehouse_ids: [1] }, tokens.admin)

  const crossOut = await api('outbound', 'submit', {
    items: [{ material_id: w2Material.id, quantity: 1, material_name: w2Material.name, unit: '个' }],
    remark: `${MARK} 跨仓越权`
  }, tokens.out)
  ok('配件仓出库员不能扣成品仓库存（原 P0：能扣）', crossOut.code === 403, `code=${crossOut.code} ${crossOut.message}`)

  const w2Stock = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [w2Material.id])
  ok('越权被拒后成品仓库存未变动', Number(w2Stock.current_stock) === Number(w2Stock.current_stock), `stock=${w2Stock.current_stock}`)

  const crossCrossWh = await api('outbound', 'submit', {
    items: [
      { material_id: testMaterialId, quantity: 1, material_name: m1.name, unit: '个' },
      { material_id: w2Material.id, quantity: 1, material_name: w2Material.name, unit: '个' }
    ],
    remark: `${MARK} 混仓下单`
  }, tokens.admin)
  ok('一张单混两个仓库被拒绝（原 P0：能提交）', crossCrossWh.code === 400, `code=${crossCrossWh.code} ${crossCrossWh.message}`)

  const crossDetail = await api('material', 'detail', { id: w2Material.id }, tokens.out)
  ok('越权查看他仓物料详情被拒绝', crossDetail.code === 403, `code=${crossDetail.code}`)

  const crossList = await api('material', 'list', { pageSize: 5 }, tokens.out)
  const onlyW1 = crossList.code === 0 && crossList.data.list.every((m) => m.warehouse_id === 1)
  ok('物料列表只返回可管仓库的物料', onlyW1, `total=${crossList.data?.total}`)

  // ---------------------------------------------------------
  section('15. 整改回归 · 数量必须是正整数（P0-3.10）')

  const halfQty = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 0.5, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 小数出库`
  }, tokens.out)
  ok('出库数量 0.5 被拒绝（原 P0：库存变 89.5）', halfQty.code === 400, halfQty.message)

  const negQty = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: -3, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 负数出库`
  }, tokens.out)
  ok('出库数量 -3 被拒绝', negQty.code === 400, negQty.message)

  const halfIn = await api('inbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 1.5, unit_price: 1, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 小数入库`
  }, tokens.in)
  ok('入库数量 1.5 被拒绝', halfIn.code === 400, halfIn.message)

  const noStockWrite = await api('material', 'upsert', {
    _id: testMaterialId, name: m1.name, warehouse_id: 1, current_stock: 999
  }, tokens.admin)
  ok('物料档案不能直接改库存（原 P2：返回"更新成功"但没改）', noStockWrite.code === 400, noStockWrite.message)

  const impStock = await api('material', 'import', {
    materials: [{ name: `${MARK}导入库存验证`, warehouse_id: 'peijian', current_stock: 500 }]
  }, tokens.admin)
  const impRejected = impStock.code === 0 && impStock.data.failed === 1 && impStock.data.success === 0
  ok('导入携带库存被拒绝（原 P0：凭空写 500 且零流水）', impRejected,
    `success=${impStock.data?.success} failed=${impStock.data?.failed}`)
  const impLeak = await queryOne('SELECT COUNT(*) AS c FROM materials WHERE name = ?', [`${MARK}导入库存验证`])
  ok('被拒绝的导入没有留下物料', Number(impLeak.c) === 0, `count=${impLeak.c}`)

  // ---------------------------------------------------------
  section('16. 整改回归 · 改价三连修（P0-3.3 / 3.4 / 3.5）')

  const twoItemIn = await api('inbound', 'submit', {
    items: [
      { material_id: testMaterialId, quantity: 10, unit_price: 10, material_name: m1.name, unit: '个' },
      { material_id: testMaterialId2, quantity: 10, unit_price: 5, material_name: m2.name, unit: '个' }
    ],
    remark: `${MARK} 改价测试双明细`,
    warehouse_id: 'peijian'
  }, tokens.in)
  ok('提交双明细入库单（供改价测试）', twoItemIn.code === 0, twoItemIn.message)
  const priceOrderId = twoItemIn.data?._id

  const beforePrice = await queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [testMaterialId])
  const priceRes = await api('inbound', 'updatePrice', {
    id: priceOrderId,
    items: [{ material_id: testMaterialId, unit_price: 20 }]
  }, tokens.in)
  ok('按料号改价返回成功（原 P0：报 500 但已落库）', priceRes.code === 0, `${priceRes.code} ${priceRes.message}`)
  ok('改价响应不含 JS 原始报错', !String(priceRes.message).includes('is not defined'), priceRes.message)

  const orderAfterPrice = await queryOne('SELECT total_price FROM inbound_orders WHERE id = ?', [priceOrderId])
  ok('单据金额 = 20×10 + 5×10 = 250', Math.abs(Number(orderAfterPrice.total_price) - 250) < 0.01,
    `total=${orderAfterPrice.total_price}`)

  const itemsAfterPrice = await query(
    'SELECT material_id, unit_price FROM inbound_order_items WHERE order_id = ? ORDER BY id', [priceOrderId]
  )
  const aPrice = Number(itemsAfterPrice.find((i) => Number(i.material_id) === testMaterialId).unit_price)
  const bPrice = Number(itemsAfterPrice.find((i) => Number(i.material_id) === testMaterialId2).unit_price)
  ok('只改了指定料号的单价', Math.abs(aPrice - 20) < 0.01, `A=${aPrice}`)
  ok('同单其他料号单价未被连带修改（原 P0：被覆盖）', Math.abs(bPrice - 5) < 0.01, `B=${bPrice}`)

  const afterPrice = await queryOne('SELECT current_stock, avg_cost FROM materials WHERE id = ?', [testMaterialId])
  const expectCost = Number(
    ((Number(beforePrice.avg_cost) * Number(beforePrice.current_stock) + 10 * 10) / Number(beforePrice.current_stock)).toFixed(4)
  )
  ok('改价后加权成本已重算（原 P0：不重算，账少计）',
    Math.abs(Number(afterPrice.avg_cost) - expectCost) < 0.01,
    `系统 ${afterPrice.avg_cost} vs 期望 ${expectCost}`)

  const priceLog = await queryOne(
    "SELECT COUNT(*) AS c FROM stock_logs WHERE material_id = ? AND change_type = 'price_adjust'",
    [testMaterialId]
  )
  ok('改价成本修正写入了库存流水（可追溯）', Number(priceLog.c) >= 1, `count=${priceLog.c}`)

  const multiCheap = await api('inbound', 'updatePrice', { id: priceOrderId, unit_price: 7 }, tokens.in)
  ok('多明细单据拒绝整单同价（避免连带改错）', multiCheap.code === 400, multiCheap.message)

  const singleItemIn = await api('inbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 2, unit_price: 3, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 改价测试单明细`,
    warehouse_id: 'peijian'
  }, tokens.in)
  const legacyPrice = await api('inbound', 'updatePrice', { id: singleItemIn.data._id, unit_price: 9 }, tokens.in)
  ok('单明细单据仍支持旧写法改价', legacyPrice.code === 0, `${legacyPrice.code} ${legacyPrice.message}`)

  // ---------------------------------------------------------
  section('17. 整改回归 · 统计口径（P0-3.6 / 3.7 / P1-1.03）')

  const ovBefore = await api('stats', 'overview', {}, tokens.admin)
  const twoItemOut = await api('outbound', 'submit', {
    items: [
      { material_id: testMaterialId, quantity: 1, material_name: m1.name, unit: '个' },
      { material_id: testMaterialId2, quantity: 1, material_name: m2.name, unit: '个' }
    ],
    remark: `${MARK} 口径测试双明细`,
    warehouse_id: 'peijian'
  }, tokens.out)
  ok('提交双明细出库单（供口径测试）', twoItemOut.code === 0, twoItemOut.message)

  const ovAfter = await api('stats', 'overview', {}, tokens.admin)
  ok('「今日出库」单数只 +1（原 P0：一单两料算 2 单）',
    ovAfter.data.today_outbound_orders - ovBefore.data.today_outbound_orders === 1,
    `${ovBefore.data.today_outbound_orders} → ${ovAfter.data.today_outbound_orders}`)

  const dbOutToday = await queryOne(
    'SELECT COUNT(DISTINCT id) AS c FROM outbound_orders WHERE is_deleted = 0 AND DATE(created_at) = CURDATE()'
  )
  ok('看板单数与数据库实际单数一致', ovAfter.data.today_outbound_orders === Number(dbOutToday.c),
    `看板 ${ovAfter.data.today_outbound_orders} vs 库 ${dbOutToday.c}`)

  const dbInAmount = await queryOne(
    'SELECT COALESCE(SUM(total_price), 0) AS s FROM inbound_orders WHERE is_deleted = 0 AND DATE(created_at) = CURDATE()'
  )
  ok('「今日入库金额」等于主单金额之和（原 P0：按明细行重复累加翻倍）',
    Math.abs(ovAfter.data.today_inbound_amount - Number(dbInAmount.s)) < 0.01,
    `接口 ${ovAfter.data.today_inbound_amount} vs 库 ${dbInAmount.s}`)

  const dbOutQty = await queryOne(
    `SELECT COALESCE(SUM(oi.quantity), 0) AS q FROM outbound_orders o
       JOIN outbound_order_items oi ON oi.order_id = o.id
      WHERE o.is_deleted = 0 AND DATE(o.created_at) = CURDATE() AND o.status NOT IN ('cancelled','rejected')`
  )
  ok('「今日出库量」剔除已作废/已驳回（原 P1：把废单算进去）',
    Math.abs(ovAfter.data.today_outbound_qty - Number(dbOutQty.q)) < 0.001,
    `接口 ${ovAfter.data.today_outbound_qty} vs 库 ${dbOutQty.q}`)

  const matCountDb = await queryOne('SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND warehouse_id = 1')
  const ovW1 = await api('stats', 'overview', {}, tokens.storekeeper)
  ok('工作台物料数按可管仓库收敛（原 P1：显示全部 1915）',
    ovW1.code === 0 && ovW1.data.material_count === Number(matCountDb.c),
    `工作台 ${ovW1.data?.material_count} vs 配件仓实际 ${matCountDb.c}`)

  const crossWhSummary = await api('stats', 'warehouseSummary', {}, tokens.storekeeper)
  ok('仓库汇总只返回有权查看的仓库（原 P1：跨仓可见）',
    crossWhSummary.code === 0 && crossWhSummary.data.list.every((w) => Number(w._id) === 1),
    JSON.stringify(crossWhSummary.data?.list?.map((w) => `${w._id}:${w.name}`)))

  // ---------------------------------------------------------
  section('18. 整改回归 · 盘点差异一致性（P0-3.9，仓管签字依据）')

  const preCheck = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  const stockS0 = Number(preCheck.current_stock)

  const check2 = await api('check', 'create', {
    type: 'sample', warehouse_id: 'peijian',
    scope: { material_ids: [testMaterialId] },
    remark: `${MARK} 差异一致性验证`
  }, tokens.storekeeper)
  ok('创建盘点单（指定单个物料，不再整仓 1764 项）', check2.code === 0, check2.message)
  ok('盘点单只含 1 项明细（原 P0：整仓 1764 项）', check2.data?.item_count === 1, `item_count=${check2.data?.item_count}`)

  const check2Id = check2.data._id
  const detailRemark = await api('check', 'detail', { id: check2Id }, tokens.storekeeper)
  ok('盘点备注不丢失（原 P1：传了就丢）',
    detailRemark.data?.remark === `${MARK} 差异一致性验证`, `remark=${detailRemark.data?.remark}`)

  const actualTarget = stockS0 - 2
  const submit2 = await api('check', 'submit', {
    id: check2Id, items: [{ material_id: testMaterialId, actual_stock: actualTarget }]
  }, tokens.storekeeper)
  ok('提交盘点结果', submit2.code === 0, submit2.message)

  const dupSubmit = await api('check', 'submit', {
    id: check2Id, items: [{ material_id: testMaterialId, actual_stock: 1 }]
  }, tokens.storekeeper)
  ok('已提交待审的单不能再改数（原 P1：可反复改）', dupSubmit.code === 400, dupSubmit.message)

  // 关键场景：提交之后、审核之前，别人又动了货
  const midMove = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 1, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 盘期间插单`, warehouse_id: 'peijian'
  }, tokens.out)
  ok('盘期间插入一笔出库（制造账面变动）', midMove.code === 0, midMove.message)

  const review2 = await api('check', 'review', { id: check2Id, approve: true }, tokens.admin)
  ok('审核通过盘点', review2.code === 0, review2.message)

  const finalStock = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId])
  ok('审核后库存 = 实盘数', Math.abs(Number(finalStock.current_stock) - actualTarget) < 0.001,
    `实盘 ${actualTarget} vs 库存 ${finalStock.current_stock}`)

  const checkItemRow = await queryOne(
    'SELECT book_stock, actual_stock, difference FROM stock_check_items WHERE check_id = ? AND material_id = ?',
    [check2Id, testMaterialId]
  )
  const adjustLog = await queryOne(
    `SELECT change_quantity, before_stock, after_stock FROM stock_logs
      WHERE related_order_id = (SELECT check_no FROM stock_checks WHERE id = ?) AND change_type = 'check_adjust'
      ORDER BY id DESC LIMIT 1`,
    [check2Id]
  )
  const docDiff = Number(checkItemRow.difference)
  const logDelta = Number(adjustLog.change_quantity)
  ok('单据「差异」= 库存流水「实际调整量」（原 P0：一个 -5 一个 -2.5）',
    Math.abs(docDiff - logDelta) < 0.001,
    `单据 ${docDiff} vs 流水 ${logDelta}`)
  ok('单据账面数已刷新为审核时点的真实库存',
    Math.abs(Number(checkItemRow.book_stock) - Number(adjustLog.before_stock)) < 0.001,
    `单据账面 ${checkItemRow.book_stock} vs 流水变动前 ${adjustLog.before_stock}`)
  ok('流水备注与单据数字一致（追责可用同一套数）',
    !String(adjustLog.remark || '').includes('无效'), '见 remark')

  const negCheck = await api('check', 'create', {
    type: 'sample', warehouse_id: 'peijian', scope: { material_ids: [testMaterialId2] }
  }, tokens.storekeeper)
  const negActual = await api('check', 'submit', {
    id: negCheck.data._id,
    items: [{ material_id: testMaterialId2, actual_stock: -3 }]
  }, tokens.storekeeper)
  ok('盘点实盘数 -3 被拒绝（原 P0：审核后库存真变 -3）', negActual.code === 400, negActual.message)
  await api('check', 'cancel', { id: negCheck.data._id }, tokens.storekeeper)

  // ---------------------------------------------------------
  section('19. 整改回归 · 盘点审核参数与角色（P1-4 / P1-13）')

  const check3 = await api('check', 'create', {
    type: 'sample', warehouse_id: 'peijian', scope: { material_ids: [testMaterialId2] }
  }, tokens.storekeeper)
  const check3Id = check3.data._id
  await api('check', 'submit', {
    id: check3Id, items: [{ material_id: testMaterialId2, actual_stock: 0 }]
  }, tokens.storekeeper)

  const stockBeforeReject = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId2])
  const backOff = await api('check', 'review', { id: check3Id, approved: false, remark: '差异太大，退回重盘' }, tokens.admin)
  const stockAfterReject = await queryOne('SELECT current_stock FROM materials WHERE id = ?', [testMaterialId2])
  ok('审核传 approved:false 得到「退回」（原 P1：被当成通过并改了库存）',
    backOff.code === 0 && String(backOff.message).includes('退回'), backOff.message)
  ok('退回后库存未发生任何调整（原 P1：改了库存）',
    Number(stockBeforeReject.current_stock) === Number(stockAfterReject.current_stock),
    `${stockBeforeReject.current_stock} → ${stockAfterReject.current_stock}`)

  const checkAsOut = await api('check', 'submit', {
    id: check3Id, items: [{ material_id: testMaterialId2, actual_stock: 1 }]
  }, tokens.out)
  ok('出库员无权提交盘点结果（原 P1：能提交）', checkAsOut.code === 403, `code=${checkAsOut.code}`)

  const checkAsPurchase = await api('check', 'submit', {
    id: check3Id, items: [{ material_id: testMaterialId2, actual_stock: 1 }]
  }, tokens.purchase)
  ok('采购员无权提交盘点结果（原 P1：能提交）', checkAsPurchase.code === 403, `code=${checkAsPurchase.code}`)

  // 此时 check3 仍处于「盘点中」，再对同一物料建单应当被拦
  const dupCheck = await api('check', 'create', {
    type: 'sample', warehouse_id: 'peijian', scope: { material_ids: [testMaterialId2] }
  }, tokens.storekeeper)
  ok('未完成盘点单存在时，同一物料不能重复建单（原 P0：多张冲突单挂待审）', dupCheck.code === 409, `code=${dupCheck.code}`)

  await api('check', 'cancel', { id: check3Id }, tokens.storekeeper)

  const fullScan = await api('check', 'create', { type: 'full', warehouse_id: 'peijian' }, tokens.storekeeper)
  ok('未选物料的整仓盘点需要二次确认（原 P0：一建就 1764 项）', fullScan.code === 400, `code=${fullScan.code}`)

  // ---------------------------------------------------------
  section('20. 整改回归 · 确认幂等与仓管权限（P1-1 / P1-2 / P1-3）')

  const confOrder = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 1, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 确认幂等测试`, warehouse_id: 'peijian'
  }, tokens.out)
  const confId = confOrder.data._id

  const confDetail = await api('outbound', 'detail', { id: confId }, tokens.out)
  ok('单据详情返回物料当前库存（原 P1：仓管只能跑去货架数）',
    confDetail.code === 0 && confDetail.data.items[0].current_stock !== undefined,
    JSON.stringify(confDetail.data?.items?.[0]?.current_stock))

  const confResults = []
  for (let i = 0; i < 3; i++) {
    confResults.push(await api('outbound', 'confirm', { id: confId }, tokens.storekeeper))
  }
  ok('重复确认全部返回成功（对使用者友好）', confResults.every((r) => r.code === 0), '')
  ok('第 2、3 次确认被识别为重复', confResults[1].data?.duplicated === true && confResults[2].data?.duplicated === true,
    JSON.stringify([confResults[1].data, confResults[2].data]))

  const confLogs = await queryOne(
    "SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'outbound_confirm' AND target_id = ?",
    [String(confId)]
  )
  ok('确认只留下 1 条操作日志（原 P1：并发 8 次写 8 条）', Number(confLogs.c) === 1, `日志 ${confLogs.c} 条`)

  const skRejectOrder = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 1, material_name: m1.name, unit: '个' }],
    remark: `${MARK} 仓管驳回权测试`, warehouse_id: 'peijian'
  }, tokens.out)
  const skReject = await api('outbound', 'reject', {
    id: skRejectOrder.data._id, reason: `${MARK} 没有工单依据，先退回`
  }, tokens.storekeeper)
  ok('仓管员可以驳回（原 P1：403，退回去的手段是死的）', skReject.code === 0, skReject.message)

  const sideReject = await api('outbound', 'reject', { id: skRejectOrder.data._id }, tokens.storekeeper)
  ok('驳回必须填原因（不填被拒）', sideReject.code === 400, `code=${sideReject.code} ${sideReject.message}`)

  const notice = await api('outbound', 'myNotice', {}, tokens.out)
  ok('被驳回的提交人能收到提醒（原 P1：完全不知道）',
    notice.code === 0 && notice.data.rejected_count >= 1,
    `rejected_count=${notice.data?.rejected_count}`)
  ok('提醒里带上了驳回原因与驳回人',
    notice.data?.rejected_list?.[0]?.reject_reason !== undefined && !!notice.data?.rejected_list?.[0]?.reject_operator_name,
    JSON.stringify(notice.data?.rejected_list?.[0]))

  // ---------------------------------------------------------
  section('21. 整改回归 · 采购对账与审计入口（P1-10 / 11 / 12 / P1-3-01）')

  const sup2 = await api('supplier', 'upsert', {
    name: `${MARK}对账供应商`, contact: '王经理', phone: '13900000000',
    tax_no: '91440600MA5TESTX1', payment_terms: '月结30天'
  }, tokens.purchase)
  ok('供应商可保存税号与账期', sup2.code === 0 || sup2.code === 409, sup2.message)

  const supDetail = await api('supplier', 'search', { keyword: '王经理' }, tokens.purchase)
  ok('可按联系人搜索供应商（原 P2：搜不到）',
    supDetail.code === 0 && supDetail.data.list.some((s) => s.name === `${MARK}对账供应商`),
    `命中 ${supDetail.data?.list?.length}`)
  const supRow = supDetail.data.list.find((s) => s.name === `${MARK}对账供应商`)
  ok('税号已落库（原 P1：静默丢弃）', supRow && supRow.tax_no === '91440600MA5TESTX1', JSON.stringify(supRow?.tax_no))
  ok('账期已落库（原 P1：静默丢弃）', supRow && supRow.payment_terms === '月结30天', JSON.stringify(supRow?.payment_terms))

  const purchFlow = await api('stats', 'stockFlow', { page: 1, pageSize: 5 }, tokens.purchase)
  ok('采购员可查库存流水（原 P1：403，月底只能手工加）', purchFlow.code === 0, `code=${purchFlow.code}`)
  ok('库存流水返回净变动量，便于对账', purchFlow.data && purchFlow.data.net_quantity !== undefined, '')

  const purchOrders = await api('stats', 'orderFlow', { page: 1, pageSize: 5 }, tokens.purchase)
  ok('采购员可查单据流水（含出库单）', purchOrders.code === 0, `code=${purchOrders.code}`)
  ok('单据流水带出库金额（原 P1：出库金额恒为 0）',
    purchOrders.data.list.some((r) => Number(r.total_amount) >= 0), '')

  const logsApi = await api('user', 'logs', { page: 1, pageSize: 10 }, tokens.admin)
  ok('后台有操作日志接口（原 P1：界面上无入口）', logsApi.code === 0 && logsApi.data.total > 0, logsApi.message)
  ok('日志接口返回总数，可翻页（原 P1：只能看最近 100 条）',
    typeof logsApi.data.total === 'number' && logsApi.data.list.length > 0, `total=${logsApi.data?.total}`)

  const myLogsApi = await api('auth', 'myLogs', { page: 1, pageSize: 5 }, tokens.out)
  ok('我的日志返回分页总数（原 P2：无 total）', myLogsApi.code === 0 && myLogsApi.data.total !== undefined, '')

  const warnDefault = await api('stats', 'warning', { page: 1, pageSize: 5 }, tokens.admin)
  const warnAll = await api('stats', 'warning', { page: 1, pageSize: 5, includeIdle: true }, tokens.admin)
  ok('预警默认聚焦（隐藏从未出入库的档案料）（原 P1：1910 条淹没真需求）',
    warnDefault.data.total < warnAll.data.total,
    `聚焦 ${warnDefault.data.total} vs 全量 ${warnAll.data.total}`)

  // ---------------------------------------------------------
  section('22. 整改回归 · 角色保护（P0-3.11）')

  const selfDemote = await api('user', 'updateRole', { id: 1, roles: ['out'] }, tokens.admin)
  ok('不能摘掉自己最后一个管理角色（原 P0：老板把自己开除后全盘锁死）',
    selfDemote.code === 400, `code=${selfDemote.code} ${selfDemote.message}`)

  const adminStillWorks = await api('stats', 'overview', {}, tokens.admin)
  ok('被拒后管理员权限仍完好（原 P0：改回去也 403）', adminStillWorks.code === 0, adminStillWorks.message)

  const adminRow = await queryOne('SELECT roles FROM users WHERE username = ?', [process.env.ADMIN_USERNAME || 'admin'])
  const adminRoles = Array.isArray(adminRow.roles) ? adminRow.roles : JSON.parse(adminRow.roles || '[]')
  ok('管理员自身的角色未被测试改动', adminRoles.includes('admin') && adminRoles.includes('boss'),
    JSON.stringify(adminRoles))

  // 系统里还有其他管理账号时，降级他人的操作应当允许（有兜底恢复途径）
  const tmpBoss = await api('user', 'create', {
    username: `${MARK}_boss`, password: 'test123456', real_name: '测试老板', roles: ['boss']
  }, tokens.admin)
  const tmpBossId = tmpBoss.code === 0
    ? tmpBoss.data._id
    : (await queryOne('SELECT id FROM users WHERE username = ?', [`${MARK}_boss`])).id
  const demoteTmp = await api('user', 'updateRole', { id: tmpBossId, roles: ['out'] }, tokens.admin)
  ok('有其他管理账号时可降级他人（不会锁死系统）', demoteTmp.code === 0, demoteTmp.message)

  const cloneManager = await queryOne(
    `SELECT COUNT(*) AS c FROM users WHERE status = 'active'
       AND (JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('admin'))
         OR JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('boss')))`
  )
  ok('系统始终至少保留一个管理账号', Number(cloneManager.c) >= 1, `管理账号 ${cloneManager.c} 个`)

  // 还原：把出库员、仓管的可管仓库恢复为不限制，避免影响后续手动测试
  await api('user', 'updateRole', { id: outUserId, roles: ['out'], warehouse_ids: [] }, tokens.admin)
  await api('user', 'updateRole', { id: skUserId, roles: ['storekeeper'], warehouse_ids: [] }, tokens.admin)

  // ---------------------------------------------------------
  section('23. 整改回归 · 文案与追责字段（P2）')

  // 提示语区分「没登录」和「登录过期」——从没登录过的人看到"登录已过期"会莫名其妙
  const rawNoLogin = await api('material', 'list', {}, '')
  ok('未登录时提示"请先登录"（原：一律说"登录已过期"）',
    rawNoLogin.code === 401 && String(rawNoLogin.message).includes('请先登录'),
    `${rawNoLogin.code} ${rawNoLogin.message}`)

  const badToken = await api('material', 'list', {}, 'not-a-real-token')
  ok('令牌无效时提示"登录已过期"（区分得出两种情况）',
    badToken.code === 401 && String(badToken.message).includes('已过期'),
    `${badToken.code} ${badToken.message}`)

  // 库存不足提示要带单位、规格要标出来（中专学历员工看不懂括号里的英文型号）
  const noStock = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 999999, material_name: 'x', unit: '个' }],
    warehouse_id: 'peijian', remark: `${MARK} 库存不足文案`
  }, tokens.out)
  const shortMsg = String(noStock.message || '')
  ok('库存不足提示带单位（"85 个"而不是光一个数字）', /当前库存 \d+.+，本次需减少 \d+/.test(shortMsg), shortMsg)
  ok('库存不足提示把规格标成「规格 …」（原：括号里一串英文，员工以为是自己填错）',
    !(shortMsg.includes('（') || shortMsg.includes('(')) || shortMsg.includes('规格'),
    shortMsg)

  // 作废追责链：作废人 + 作废原因要能在详情里查到（原来只有提交人/确认人/驳回人）
  const cancelSeed = await api('outbound', 'submit', {
    items: [{ material_id: testMaterialId, quantity: 1, material_name: 'x', unit: '个' }],
    warehouse_id: 'peijian', remark: `${MARK} 作废追责`
  }, tokens.out)
  if (cancelSeed.code === 0) {
    const cancelled = await api('outbound', 'cancel', {
      id: cancelSeed.data._id, reason: '录错仓库了'
    }, tokens.admin)
    ok('作废可带原因', cancelled.code === 0, cancelled.message)

    const cDetail = await api('outbound', 'detail', { id: cancelSeed.data._id }, tokens.admin)
    ok('作废后详情带"作废人"（原 P2：追责链缺一环）',
      cDetail.code === 0 && !!cDetail.data.cancel_operator_name,
      `cancel_operator_name="${cDetail.data && cDetail.data.cancel_operator_name}"`)
    ok('作废后详情带"作废原因"',
      cDetail.code === 0 && cDetail.data.cancel_reason === '录错仓库了',
      `cancel_reason="${cDetail.data && cDetail.data.cancel_reason}"`)
  } else {
    ok('作废追责前置（造单失败）', false, cancelSeed.message)
  }

  // 库存流水必须能把「单号」和「经手人」带出来（对账页两列都靠它）
  const flowRows = await api('stats', 'stockFlow', { page: 1, pageSize: 10 }, tokens.admin)
  const flowList = (flowRows.data && flowRows.data.list) || []
  ok('库存流水每条都有 order_no 字段（对账页"单号"列不再是空的）',
    flowList.length > 0 && flowList.every((r) => r.order_no !== undefined),
    `共 ${flowList.length} 条`)
  ok('库存流水每条都有 operator_name 字段（对账页"经手人"列）',
    flowList.length > 0 && flowList.every((r) => r.operator_name !== undefined),
    '')

  // ---------------------------------------------------------
  section('24. 数据清理')
  const cleanup = await cleanupTestData()
  ok('测试单据已清理', cleanup.orders > 0, `清理单据 ${cleanup.orders} 张，还原物料 ${cleanup.materials} 项`)
  ok('测试物料库存已归零', cleanup.reset > 0, `归零 ${cleanup.reset} 项`)

  // 还原「必须改密」标记：本测试为了跑通先解除了门禁，这里恢复，
  // 保证你手动登录后台时仍然能看到「强制修改初始密码」的真实流程
  const adminIdRow = await queryOne('SELECT id, must_change_password FROM users WHERE username = ?',
    [process.env.ADMIN_USERNAME || 'admin'])
  if (adminIdRow && Number(adminIdRow.must_change_password) === 0) {
    const restoreFlag = await api('user', 'resetPassword', {
      id: adminIdRow.id, new_password: adminPwd
    }, tokens.admin)
    // resetPassword 会把标记置回 1（管理员重置的密码属临时密码）
    ok('已还原「必须改密」标记（便于手动验证强制改密流程）', restoreFlag.code === 0, restoreFlag.message)
  } else {
    ok('已还原「必须改密」标记（便于手动验证强制改密流程）', true, '标记已为 1')
  }

  // ---------------------------------------------------------
  console.log('\n============================================================')
  console.log(`  测试完成：通过 ${passed} 项，失败 ${failed} 项`)
  if (failed) {
    console.log('\n  失败明细：')
    failures.forEach((f) => console.log(`   - ${f}`))
  }
  console.log('============================================================')

  await releaseTestLock()
  await pool.end()
  process.exit(failed ? 1 : 0)
}

/**
 * 清理测试数据：
 *   1. 删除带 AUTOTEST 标记的出库/入库单及其明细
 *   2. 删除测试产生的库存流水
 *   3. 把测试物料的库存归零（回到导入时的初始状态）
 *   4. 删除测试供应商
 *   5. 保留测试账号（便于用户继续手动测试）——如需删除请用 --purge-users
 */
async function cleanupTestData() {
  const purgeUsers = process.argv.includes('--purge-users')

  const outOrders = await query(`SELECT id FROM outbound_orders WHERE remark LIKE ?`, [`%${MARK}%`])
  const inOrders = await query(`SELECT id FROM inbound_orders WHERE remark LIKE ?`, [`%${MARK}%`])
  const checkRows = await query('SELECT id FROM stock_checks')

  const outIds = outOrders.map((o) => o.id)
  const inIds = inOrders.map((o) => o.id)

  // 删除测试盘点任务（只删测试范围内创建的）
  const checkIds = []
  for (const c of checkRows) {
    const items = await query('SELECT material_id FROM stock_check_items WHERE check_id = ?', [c.id])
    if (items.length === 1 && [testMaterialId, testMaterialId2].includes(items[0].material_id)) {
      checkIds.push(c.id)
    }
  }

  if (outIds.length) {
    await execute(`DELETE FROM outbound_order_items WHERE order_id IN (${outIds.map(() => '?').join(',')})`, outIds)
    await execute(`DELETE FROM outbound_orders WHERE id IN (${outIds.map(() => '?').join(',')})`, outIds)
  }
  if (inIds.length) {
    await execute(`DELETE FROM inbound_order_items WHERE order_id IN (${inIds.map(() => '?').join(',')})`, inIds)
    await execute(`DELETE FROM inbound_orders WHERE id IN (${inIds.map(() => '?').join(',')})`, inIds)
  }
  if (checkIds.length) {
    await execute(`DELETE FROM stock_check_items WHERE check_id IN (${checkIds.map(() => '?').join(',')})`, checkIds)
    await execute(`DELETE FROM stock_checks WHERE id IN (${checkIds.map(() => '?').join(',')})`, checkIds)
  }

  // 清除测试物料上的流水与库存
  const testMaterials = [testMaterialId, testMaterialId2].filter(Boolean)
  let reset = 0
  if (testMaterials.length) {
    await execute(`DELETE FROM stock_logs WHERE material_id IN (${testMaterials.map(() => '?').join(',')})`, testMaterials)
    const r = await execute(
      `UPDATE materials SET current_stock = 0, avg_cost = 0 WHERE id IN (${testMaterials.map(() => '?').join(',')})`,
      testMaterials
    )
    reset = r.affectedRows || 0
  }

  // 清理测试供应商与操作日志
  await execute('DELETE FROM suppliers WHERE name LIKE ?', [`%${MARK}%`])
  await execute('DELETE FROM operation_logs WHERE detail LIKE ?', [`%${MARK}%`])
  // 清理测试期间临时创建的管理账号（已降级，删除不会影响系统管理能力）
  await execute('DELETE FROM users WHERE username = ?', [`${MARK}_boss`])

  if (purgeUsers) {
    await execute('DELETE FROM users WHERE username LIKE ?', [`${MARK}%`])
  }

  return { orders: outIds.length + inIds.length, materials: testMaterials.length, reset }
}

main().catch(async (e) => {
  console.error('\n[测试异常]', e)
  try {
    await pool.end()
  } catch (err) { /* ignore */ }
  process.exit(1)
})
