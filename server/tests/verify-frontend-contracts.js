/**
 * 前端契约验证（真实 HTTP）
 * ============================================================
 * 目的：本轮整改改了小程序与后台的多个页面，这些页面依赖的接口签名/返回字段
 *      必须与前端代码严格一致。这里用真实 HTTP 请求逐项验证，避免"界面写好了但接口对不上"。
 *
 * 数据安全（重要）：
 *   1) 业务验证全部使用【契约验证】开头的临时物料，不动 1909 条真实物料；
 *   2) 脚本开始时记录 stock_logs 的最大 id，结束时删除本轮新增的流水；
 *   3) 本轮创建的单据 / 盘点单 / 临时物料一并清理；
 *   4) 若发现真实物料库存或成本被改动，脚本会明确报错提醒。
 *
 * 用法：node tests/verify-frontend-contracts.js
 */
const { queryOne, execute } = require('../src/db/pool')
const { acquireTestLock, releaseTestLock } = require('./_test-lock')

const BASE = 'http://localhost:3000/api'
const TAG = '【契约验证】'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`)
  }
}

function section(title) {
  console.log('')
  console.log('─'.repeat(60))
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

async function call(module, action, data = {}, token) {
  const res = await fetch(`${BASE}/${module}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      action,
      data,
      client_request_id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    })
  })
  return res.json()
}

async function login(username, password) {
  const r = await call('auth', 'adminLogin', { username, password })
  if (r.code !== 0) return { token: null, raw: r }
  return { token: r.data.token, mustChange: !!r.data.must_change_password, raw: r }
}

/** 本轮产生的痕迹，用于最后清理 */
const created = {
  materialIds: [],
  inboundOrderIds: [],
  outboundOrderIds: [],
  checkIds: [],
  orderNos: []
}

;(async () => {
  console.log('')
  console.log('═'.repeat(60))
  console.log('  前端契约验证（真实 HTTP · 逐项对照前端代码）')
  console.log('═'.repeat(60))

  // 与 api-test.js 互斥：两套测试都会删「自己开始之后的数据」，
  // 同时跑会互相误删，出现假故障（详见 tests/_test-lock.js）
  await acquireTestLock('前端契约验证')

  // 记录基线，用于最后核对与清理
  const baseLog = await queryOne('SELECT COALESCE(MAX(id), 0) AS m FROM stock_logs')
  const baseLogId = Number(baseLog.m || 0)
  const dirtyMaterials = await queryOne(
    'SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND current_stock <> 0'
  )

  /* ============================================================
   * 1. 登录
   * ============================================================ */
  section('1. 登录与身份')

  const zs = await login('zhangshan', 'zs123456')
  const ln = await login('lina', 'ln123456')
  const zl = await login('zhaoliu', 'zl123456')
  const wz = await login('wangzong', 'wz123456')

  ok('出库员账号可登录', !!zs.token)
  ok('采购员账号可登录', !!ln.token)
  ok('仓管账号可登录', !!zl.token)
  ok('老板账号可登录', !!wz.token)

  if (!zl.token || !ln.token || !wz.token) {
    console.log('\n关键账号登录失败，无法继续验证')
    process.exit(1)
  }

  /* ============================================================
   * 2. 准备临时物料（只动测试料，不碰真实物料）
   * ============================================================ */
  section('2. 准备临时测试物料')

  const whs0 = await call('stats', 'warehouseSummary', {}, wz.token)
  const whForTest = whs0.code === 0 ? (whs0.data.list || [])[0] : null
  ok('取到可用仓库（用于挂临时物料）', !!whForTest)

  if (!whForTest) {
    console.log('\n没有可用仓库，无法继续')
    process.exit(1)
  }

  const matA = await call('material', 'upsert', {
    name: `${TAG}临时料A`,
    spec: `CT-A-${Date.now()}`,
    category: '契约验证',
    unit: '个',
    warehouse_id: whForTest._id,
    warning_stock: 0
  }, wz.token)
  const matB = await call('material', 'upsert', {
    name: `${TAG}临时料B`,
    spec: `CT-B-${Date.now()}`,
    category: '契约验证',
    unit: '个',
    warehouse_id: whForTest._id,
    warning_stock: 0
  }, wz.token)

  ok('创建临时物料 A（验证用，结束时删除）', matA.code === 0, matA.message)
  ok('创建临时物料 B（验证用，结束时删除）', matB.code === 0, matB.message)
  const idA = matA.code === 0 ? matA.data._id : null
  const idB = matB.code === 0 ? matB.data._id : null
  if (idA) created.materialIds.push(idA)
  if (idB) created.materialIds.push(idB)

  ok('物料档案接口拒绝直接写库存（P0-3.8：不能凭空写数）',
    (await call('material', 'upsert', {
      name: `${TAG}不该成功`, warehouse_id: whForTest._id, current_stock: 999
    }, wz.token)).code !== 0)

  /* ============================================================
   * 3. 首页「被驳回提醒」（outbound/myNotice）
   * ============================================================ */
  section('3. 首页驳回提醒 outbound/myNotice')

  const noticeZs = await call('outbound', 'myNotice', {}, zs.token)
  ok('出库员可调 myNotice（原：提交人被驳回后不知道）', noticeZs.code === 0, noticeZs.message)
  ok('返回 rejected_count 字段（前端用于角标）',
    noticeZs.code === 0 && typeof noticeZs.data.rejected_count === 'number')
  ok('返回 rejected_list 数组（前端逐条展示原因）',
    noticeZs.code === 0 && Array.isArray(noticeZs.data.rejected_list))

  /* ============================================================
   * 4. 盘点：选仓库 + 选物料（小程序新增的选料入口）
   * ============================================================ */
  section('4. 盘点选仓库与选物料')

  const whs = await call('stats', 'warehouseSummary', {}, zl.token)
  ok('仓管可调 warehouseSummary（盘点页选仓库的数据源）', whs.code === 0, whs.message)
  ok('仓库列表含 _id / name / material_count（前端取这三个字段）',
    whs.code === 0 && whs.data.list.length > 0 &&
    whs.data.list.every((w) => w._id !== undefined && w.name && w.material_count !== undefined))

  const mats = await call('material', 'list', {
    keyword: TAG,
    warehouse_id: whForTest._id,
    page: 1,
    pageSize: 5
  }, zl.token)
  ok('按 warehouse_id + keyword 拉物料（选料弹层的数据源）', mats.code === 0, mats.message)
  ok('物料返回含 _id / name / spec / unit / current_stock（弹层展示需要）',
    mats.code === 0 && (mats.data.list || []).length > 0 &&
    mats.data.list.every((m) => m._id !== undefined && m.name && m.current_stock !== undefined))

  // ---- 物料必须能按仓库分开取（领料/入库/采购三个选料页分仓的数据契约）----
  const whAll = await call('stats', 'warehouseSummary', {}, wz.token)
  const whList = whAll.code === 0 ? (whAll.data.list || []) : []
  if (whList.length >= 2) {
    const all = await call('material', 'list', { page: 1, pageSize: 1 }, wz.token)
    const onlyA = await call('material', 'list', { warehouse_id: whList[0]._id, page: 1, pageSize: 100 }, wz.token)
    const onlyB = await call('material', 'list', { warehouse_id: whList[1]._id, page: 1, pageSize: 100 }, wz.token)

    ok('不传仓库时返回全部物料（原：只能看混合列表）', all.code === 0, all.message)
    ok('传 warehouse_id 后只返回该仓库的物料（选料页分仓的依据）',
      onlyA.code === 0 && (onlyA.data.list || []).length > 0 &&
      onlyA.data.list.every((m) => Number(m.warehouse_id) === Number(whList[0]._id)),
      `「${whList[0].name}」返回 ${onlyA.data.total} 条`)
    ok('两个仓库物料数之和 = 全部（没漏也没重）',
      onlyA.code === 0 && onlyB.code === 0 &&
      (onlyA.data.total + onlyB.data.total) === all.data.total,
      `${onlyA.data.total} + ${onlyB.data.total} = ${all.data.total}`)
  } else {
    ok('物料按仓库分开（仓库不足 2 个，跳过）', true)
  }

  if (idA) {
    const createdCheck = await call('check', 'create', {
      type: 'sample',
      warehouse_id: whForTest._id,
      scope: { material_ids: [idA], categories: [] },
      confirm_full_scan: false
    }, zl.token)
    ok('指定 1 项物料创建抽盘单（原：界面写死空数组，必然整仓）',
      createdCheck.code === 0, createdCheck.message)

    if (createdCheck.code === 0) {
      const cid = createdCheck.data._id
      created.checkIds.push(cid)

      const d = await call('check', 'detail', { id: cid }, zl.token)
      const items = d.code === 0 ? (d.data.items || []) : []
      ok('盘点单明细数 = 1（证明选料真的生效，不是整仓）', items.length === 1, `实际 ${items.length} 项`)
      ok('明细含 book_stock（提交页显示账面数用）',
        items.length === 0 || items[0].book_stock !== undefined)
      ok('明细的 actual_stock 初始为 null（前端据此转成空输入框）',
        items.length === 0 || items[0].actual_stock === null || items[0].actual_stock === undefined)
    }

    // 整仓守卫
    const fullScan = await call('check', 'create', {
      type: 'full',
      warehouse_id: whForTest._id,
      scope: { material_ids: [], categories: [] }
    }, zl.token)
    if (Number(whForTest.material_count) > 200) {
      ok('整仓盘点被守卫拦下并要求二次确认（前端据此弹确认框）',
        fullScan.code !== 0, fullScan.message)
      ok('拦截提示是中文人话（不是数据库报错）',
        fullScan.code !== 0 && /全盘|确认|物料/.test(fullScan.message || ''))
    } else {
      ok('整仓守卫（本仓物料较少，不触发）', true)
      if (fullScan.code === 0) created.checkIds.push(fullScan.data._id)
    }
  }

  /* ============================================================
   * 5. 仓管「确认前先看库存」（outbound/detail）
   * ============================================================ */
  section('5. 仓管确认前看到当前库存')

  let pendingOrder = null
  if (idA) {
    // 用临时料造一张待确认出库单（先给临时料入点货，才能出库）
    const inSeed = await call('inbound', 'submit', {
      items: [{ material_id: idA, quantity: 10, unit_price: 5 }],
      supplier: `${TAG}种子`,
      remark: `${TAG}为出库验证铺底`,
      warehouse_id: whForTest._id
    }, ln.token)
    if (inSeed.code === 0) {
      created.inboundOrderIds.push(inSeed.data._id)
      created.orderNos.push(inSeed.data.order_no)

      const outSeed = await call('outbound', 'submit', {
        items: [{ material_id: idA, quantity: 2 }],
        type: 'lingyong',
        remark: `${TAG}出库详情验证`,
        warehouse_id: whForTest._id
      }, zs.token)
      if (outSeed.code === 0) {
        created.outboundOrderIds.push(outSeed.data._id)
        created.orderNos.push(outSeed.data.order_no)
        pendingOrder = outSeed.data._id
      }
    }
  }

  ok('可用临时料造出待确认出库单（验证前置）', !!pendingOrder)

  if (pendingOrder) {
    const d = await call('outbound', 'detail', { id: pendingOrder }, zl.token)
    const items = d.code === 0 ? (d.data.items || []) : []
    ok('出库单详情的明细带 current_stock（原：仓管只能跑去货架数）',
      items.length === 0 || items[0].current_stock !== undefined)
    ok('明细带 stock_enough（前端标红"库存不足"用）',
      items.length === 0 || items[0].stock_enough !== undefined)
    ok('单据带 status_text 中文字段', d.code === 0 && !!d.data.status_text)

    const pendingOut = await call('outbound', 'list', { status: 'pending', page: 1, pageSize: 5 }, zl.token)
    ok('仓管可查待确认出库单', pendingOut.code === 0, pendingOut.message)
  }

  /* ============================================================
   * 6. 采购对账：库存流水 + 出库单可见
   * ============================================================ */
  section('6. 采购员的对账链路（P1-12）')

  const flow = await call('stats', 'stockFlow', { page: 1, pageSize: 5 }, ln.token)
  ok('采购员可查库存流水（原：403，月底只能手工加）', flow.code === 0, flow.message)
  ok('流水返回 total（前端显示"共 N 笔"）',
    flow.code === 0 && typeof flow.data.total === 'number')
  ok('流水返回 net_quantity（前端显示净变动）',
    flow.code === 0 && typeof flow.data.net_quantity === 'number')
  if (flow.code === 0 && (flow.data.list || []).length) {
    const rows = flow.data.list
    ok('流水带 change_type_text 中文类型（原：界面显示英文）', !!rows[0].change_type_text)
    // 对账页每行都要能取到「单号 / 经手人」两个字段，缺一个那列就是空的
    ok('每条流水都带 order_no 字段（对账页单号列，原：字段名对不上，永远显示 —）',
      rows.every((r) => r.order_no !== undefined))
    ok('每条流水都带 operator_name 字段（对账页经手人列）',
      rows.every((r) => r.operator_name !== undefined))
    // 字段在 ≠ 有值：本轮造了真实单据，必须至少有一条流水能带出单号
    ok('至少一条流水带出真实单号（不是空字符串）',
      rows.some((r) => !!r.order_no))
    ok('至少一条流水带出真实经手人',
      rows.some((r) => !!r.operator_name))
  } else {
    ok('流水字段（当前无流水，跳过）', true)
  }

  const po = await call('outbound', 'list', { page: 1, pageSize: 20 }, ln.token)
  ok('采购员可看出库单（原：看不到，对账缺一半）', po.code === 0, po.message)
  const poList = (po.data && po.data.list) || []
  // 「能调通」不等于「看得到」：采购员几乎不提交出库单，
  // 如果可见范围只给「本人」，接口会返回成功但列表恒为空 —— 对账照样缺一半。
  // 这里用张三提交的单号做实证（ln 是李娜，不是同一人）。
  ok('采购员能看到「别人提交的」出库单（原：只给本人 → 接口通但一单看不到）',
    poList.some((r) => created.outboundOrderIds.includes(Number(r._id))),
    `共 ${poList.length} 单，期望含 ${created.outboundOrderIds.join('/')}`)
  ok('出库单列表带明细（对账要看扣了哪些料）',
    poList.length === 0 || Array.isArray(poList[0].items))
  if (created.outboundOrderIds.length) {
    const otherDetail = await call('outbound', 'detail', { id: created.outboundOrderIds[0] }, ln.token)
    ok('采购员能打开「别人提交的」出库单详情（与列表可见范围一致）',
      otherDetail.code === 0, otherDetail.message)
  }

  const po2 = await call('stats', 'orderFlow', { page: 1, pageSize: 5 }, ln.token)
  ok('采购员可查单据流水', po2.code === 0, po2.message)

  /* ============================================================
   * 7. 老板：操作日志页 + 预警聚焦
   * ============================================================ */
  section('7. 后台操作日志与预警')

  const logs = await call('user', 'logs', { page: 1, pageSize: 10 }, wz.token)
  ok('老板可调 user/logs（后台新增的操作日志页）', logs.code === 0, logs.message)
  ok('日志返回 total（分页组件需要）', logs.code === 0 && typeof logs.data.total === 'number')
  ok('日志返回 actions 聚合（筛选下拉的数据源）',
    logs.code === 0 && Array.isArray(logs.data.actions) && logs.data.actions.length > 0)
  if (logs.code === 0 && (logs.data.list || []).length) {
    const g = logs.data.list[0]
    ok('日志行含 created_at / user_name / action / detail（页面列都依赖它）',
      g.created_at !== undefined && g.user_name !== undefined &&
      g.action !== undefined && g.detail !== undefined)
  }

  const warnFocus = await call('stats', 'warning', { page: 1, pageSize: 5, includeIdle: false }, wz.token)
  const warnAll = await call('stats', 'warning', { page: 1, pageSize: 5, includeIdle: true }, wz.token)
  ok('预警默认聚焦（隐藏从未出入库的档案料）', warnFocus.code === 0, warnFocus.message)
  ok('includeIdle=true 时返回条数 >= 默认（开关真的生效）',
    warnAll.code === 0 && warnFocus.code === 0 &&
    Number(warnAll.data.total) >= Number(warnFocus.data.total),
    `默认 ${warnFocus.code === 0 ? warnFocus.data.total : '?'} vs 含闲置 ${warnAll.code === 0 ? warnAll.data.total : '?'}`)
  if (warnAll.code === 0 && (warnAll.data.list || []).length) {
    ok('预警行带 severity 字段（前端分级标签）', warnAll.data.list[0].severity !== undefined)
  }

  /* ============================================================
   * 8. 改密页契约
   * ============================================================ */
  section('8. 修改密码（强制改密页）')

  const badChange = await call('auth', 'changePassword', {
    old_password: 'definitely-wrong-password',
    new_password: 'whatever123'
  }, zs.token)
  ok('原密码错误时明确拒绝（前端提示"原密码不正确"）',
    badChange.code !== 0 && /原密码/.test(badChange.message || ''), badChange.message)

  const shortPw = await call('auth', 'changePassword', {
    old_password: 'zs123456',
    new_password: '123'
  }, zs.token)
  ok('新密码过短被拒（前端也做了 6 位校验）',
    shortPw.code !== 0 && /6/.test(shortPw.message || ''), shortPw.message)

  const myInfo = await call('auth', 'getUserInfo', {}, zs.token)
  ok('getUserInfo 可用（改密页所在布局依赖登录态）', myInfo.code === 0, myInfo.message)
  ok('用户信息含 username（前端 identity 回退用它比对"我的单"）',
    myInfo.code === 0 && !!myInfo.data.username)

  /* ============================================================
   * 9. 改价：多明细按 material_id 精确改（前端弹层契约）
   * ============================================================ */
  section('9. 改价接口契约（按 material_id 精确改）')

  if (idA && idB) {
    const createdIn = await call('inbound', 'submit', {
      items: [
        { material_id: idA, quantity: 1, unit_price: 10 },
        { material_id: idB, quantity: 1, unit_price: 20 }
      ],
      supplier: `${TAG}改价验证`,
      remark: `${TAG}多明细改价，验证后作废`,
      warehouse_id: whForTest._id
    }, ln.token)
    ok('用临时料构造多明细入库单（改价验证前置）', createdIn.code === 0, createdIn.message)

    if (createdIn.code === 0) {
      const oid = createdIn.data._id
      created.inboundOrderIds.push(oid)
      created.orderNos.push(createdIn.data.order_no)

      const legacy = await call('inbound', 'updatePrice', { id: oid, unit_price: 1 }, ln.token)
      ok('多明细单用旧写法（整单同价）被明确拒绝（防整单被覆盖）', legacy.code !== 0, legacy.message)
      ok('拒绝提示是中文且说清原因',
        legacy.code !== 0 && /明细|指定|material_id/i.test(legacy.message || ''), legacy.message)

      const precise = await call('inbound', 'updatePrice', {
        id: oid,
        items: [{ material_id: idA, unit_price: 12.5 }]
      }, ln.token)
      ok('按 items[].material_id 精确改价成功（前端弹层用的就是这种入参）',
        precise.code === 0, precise.message)

      const after = await call('inbound', 'detail', { id: oid }, ln.token)
      const its = after.code === 0 ? (after.data.items || []) : []
      const a = its.find((x) => Number(x.material_id) === Number(idA))
      const b = its.find((x) => Number(x.material_id) === Number(idB))
      ok('只有指定那项被改（原：整单被覆盖成同一个价）',
        a && b && Number(a.unit_price) === 12.5 && Number(b.unit_price) === 20,
        `改了 ${a ? a.unit_price : '?'} / 未改 ${b ? b.unit_price : '?'}`)

      const detailIn = await call('inbound', 'detail', { id: oid }, ln.token)
      ok('入库详情明细带 current_stock（对账看现存）',
        detailIn.code === 0 && ((detailIn.data.items || [])[0] || {}).current_stock !== undefined)
    }
  }

  /* ============================================================
   * 9.5 扫码搜料：完整物料编号必须精确命中
   *     小程序里的扫码 = 把扫到的内容当关键词去搜物料。
   *     如果这里走模糊匹配，扫 A001-1 会把 A001-10 ~ A001-19 一起捞出来（共 11 条），
   *     员工对着货架扫一个码要在一堆结果里猜，扫码就白做了。
   *     同时要保证前缀和名称仍然能模糊搜到，不能矫枉过正。
   * ============================================================ */
  section('9.5 扫码搜料（完整编号精确命中）')

  const partsWhId = whForTest._id
  const scanHit = await call('material', 'list', {
    keyword: 'A001-1',
    warehouse_id: partsWhId
  }, zs.token)
  ok('扫完整编号可调通', scanHit.code === 0, scanHit.message)
  ok(
    '扫 A001-1 只命中 1 条（不能串出 A001-10~A001-19）',
    scanHit.code === 0 && scanHit.data.total === 1,
    `实际 ${scanHit.code === 0 ? scanHit.data.total : '-'} 条`
  )
  ok(
    '命中的正是 A001-1 本身',
    scanHit.code === 0 && !!scanHit.data.list &&
      !!scanHit.data.list[0] &&
      scanHit.data.list[0].material_no === 'A001-1',
    scanHit.code === 0 && scanHit.data.list && scanHit.data.list[0]
      ? scanHit.data.list[0].material_no
      : '无数据'
  )

  const scanPrefix = await call('material', 'list', {
    keyword: 'A001',
    warehouse_id: partsWhId,
    pageSize: 1
  }, zs.token)
  ok(
    '输大类前缀仍按模糊搜索返回多条',
    scanPrefix.code === 0 && scanPrefix.data.total > 1,
    `实际 ${scanPrefix.code === 0 ? scanPrefix.data.total : '-'} 条`
  )

  const scanName = await call('material', 'list', {
    keyword: '冷板',
    warehouse_id: partsWhId,
    pageSize: 1
  }, zs.token)
  ok(
    '按名称模糊搜索仍可用',
    scanName.code === 0 && scanName.data.total > 0,
    `实际 ${scanName.code === 0 ? scanName.data.total : '-'} 条`
  )

  /* ============================================================
   * 10. 清理（只删本轮产生的痕迹，不动真实数据）
   * ============================================================ */
  section('10. 清理本轮验证痕迹')

  // 单据先作废（回退库存），再删流水与记录
  for (const id of created.outboundOrderIds) {
    await call('outbound', 'cancel', { id, reason: `${TAG}验证结束清理` }, wz.token).catch(() => {})
  }
  for (const id of created.inboundOrderIds) {
    await call('inbound', 'cancel', { id, reason: `${TAG}验证结束清理` }, wz.token).catch(() => {})
  }
  for (const id of created.checkIds) {
    await call('check', 'cancel', { id }, wz.token).catch(() => {})
  }

  // 删除本轮新增的库存流水（按基线 id 精确界定）
  if (created.orderNos.length) {
    const ph = created.orderNos.map(() => '?').join(',')
    await execute(`DELETE FROM stock_logs WHERE related_order_id IN (${ph})`, created.orderNos)
  }
  await execute('DELETE FROM stock_logs WHERE id > ?', [baseLogId])

  // 删除本轮创建的单据与盘点单（含明细）
  if (created.inboundOrderIds.length) {
    const ph = created.inboundOrderIds.map(() => '?').join(',')
    await execute(`DELETE FROM inbound_order_items WHERE order_id IN (${ph})`, created.inboundOrderIds)
    await execute(`DELETE FROM inbound_orders WHERE id IN (${ph})`, created.inboundOrderIds)
  }
  if (created.outboundOrderIds.length) {
    const ph = created.outboundOrderIds.map(() => '?').join(',')
    await execute(`DELETE FROM outbound_order_items WHERE order_id IN (${ph})`, created.outboundOrderIds)
    await execute(`DELETE FROM outbound_orders WHERE id IN (${ph})`, created.outboundOrderIds)
  }
  if (created.checkIds.length) {
    const ph = created.checkIds.map(() => '?').join(',')
    await execute(`DELETE FROM stock_check_items WHERE check_id IN (${ph})`, created.checkIds)
    await execute(`DELETE FROM stock_checks WHERE id IN (${ph})`, created.checkIds)
  }

  // 删除临时物料
  if (created.materialIds.length) {
    const ph = created.materialIds.map(() => '?').join(',')
    await execute(`DELETE FROM materials WHERE id IN (${ph})`, created.materialIds)
  }

  const afterLog = await queryOne('SELECT COUNT(*) AS c FROM stock_logs')
  const afterMat = await queryOne(
    'SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0 AND current_stock <> 0'
  )
  const afterZero = await queryOne('SELECT COUNT(*) AS c FROM materials WHERE is_deleted = 0')

  ok('本轮新增的库存流水已全部清除', Number(afterLog.c) === baseLogId || Number(afterLog.c) === 0,
    `剩余 ${afterLog.c} 条`)
  ok('真实物料库存仍未被污染', Number(afterMat.c) === Number(dirtyMaterials.c || 0),
    `验证前 ${dirtyMaterials.c} 条非零，现在 ${afterMat.c} 条`)
  ok('真实物料条数未减少（1909 条级别）', Number(afterZero.c) >= 1900, `当前 ${afterZero.c} 条`)

  /* ============================================================
   * 汇总
   * ============================================================ */
  console.log('')
  console.log('═'.repeat(60))
  console.log(`  验证完成：通过 ${pass} 项，失败 ${fail} 项`)
  if (failures.length) {
    console.log('  失败项：')
    failures.forEach((f) => console.log(`    - ${f}`))
  }
  console.log('═'.repeat(60))
  console.log('')

  await releaseTestLock()
  process.exit(fail ? 1 : 0)
})().catch((err) => {
  console.error('\n验证脚本异常：', err)
  process.exit(1)
})
