/**
 * ============================================================
 * V3 · P0/P1 独立复核（主 Agent 自己做，不采信岗位 Agent 的结论）
 * ------------------------------------------------------------
 * 原则（来自测试方法论）：
 *   · Agent 报的每条 P0，自己独立复核一遍
 *   · 复核优先级：读源码确认根因 ＞ 实际发请求复现
 *   · 会造成不可恢复后果的操作**不复现**，只写源码结论（见文末说明）
 *
 * 本脚本复核 6 条，每条都给「复现前会怎样 / 复现后应该怎样」的对照：
 *   R1  老板能否凭空创建 admin 账号（P0，可安全复现，建完立即禁用）
 *   R2  老板能否直接把 admin 降级（P0，源码确认 + 不实际复现，原因见文末）
 *   R3  直接入库单价填 0 是否被拦（P1）
 *   R4  仓管能否查看本仓、别人建的盘点单（P1）
 *   R5  material.upsert 是否接受不存在的仓库（P1，会造孤儿物料）
 *   R6  出库单"拆行"能否绕过库存校验（P1）
 *
 * 用法：node tests/v3-p0-recheck.js
 * ============================================================
 */
require('../src/config/env')
const http = require('http')
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'

function call(moduleName, action, data = {}, token = '', clientRequestId = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ action, data, ...(clientRequestId ? { client_request_id: clientRequestId } : {}) })
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(`${BASE}/api/${moduleName}`, { method: 'POST', headers, timeout: 20000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch { reject(new Error(raw.slice(0, 200))) } })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')) })
    req.write(payload)
    req.end()
  })
}

const results = []
function record(id, title, expected, actual, verdict, evidence) {
  results.push({ id, title, expected, actual, verdict, evidence })
  console.log(`\n【${id}】${title}`)
  console.log(`  预期：${expected}`)
  console.log(`  实测：${actual}`)
  console.log(`  判定：${verdict}`)
  if (evidence) console.log(`  证据：${evidence}`)
}

async function login(role) {
  const r = await call('auth', 'login', { dev_openid: role })
  if (r.code !== 0) throw new Error(`${role} 登录失败：${r.message}`)
  return r.data.token
}

;(async () => {
  console.log('════════ V3 · P0/P1 独立复核 ════════')
  console.log(`目标：${BASE}`)

  const T = {
    out: await login('dev_out'),
    sk: await login('dev_sk'),
    purchase: await login('dev_purchase'),
    boss: await login('dev_boss')
  }
  const adminRes = await call('auth', 'adminLogin', { username: 'admin', password: '123456' })
  T.admin = adminRes.data.token
  console.log('身份就绪：out / sk / purchase / boss / admin')

  // 找一个测试物料的 id
  const matRes = await call('material', 'list', { keyword: '【测试】火花塞', pageSize: 5 }, T.sk)
  const MAT = ((matRes.data && matRes.data.list) || [])[0]
  if (!MAT) throw new Error('找不到测试物料，请先跑 v3-test-setup.js')
  console.log(`测试物料：${MAT.name} (id=${MAT._id})`)

  // ============================================================
  // R1：老板能否凭空创建 admin 账号（可安全复现：建完立即禁用）
  // ============================================================
  const uniq = Date.now().toString().slice(-6)
  const r1name = `V3RECHECK_${uniq}`
  const r1 = await call('user', 'create', {
    username: r1name, password: 'test123456', real_name: '复核探针账号',
    roles: ['admin'], warehouse_ids: [1, 2]
  }, T.boss)

  if (r1.code === 0) {
    // 立即禁用，避免留下能用的后门账号
    await call('user', 'disable', { id: r1.data._id }, T.admin)
    record('R1', '老板（非管理员）能否直接创建一个「管理员」账号',
      '应被拒（只有管理员能授予管理员角色）',
      `创建成功 code=0，新账号 id=${r1.data._id}，角色 ["admin"]（已立即禁用）`,
      '❌ 漏洞成立（P0）',
      `POST /api/user {action:"create"} by dev_boss → ${JSON.stringify(r1).slice(0, 120)}`)
  } else {
    record('R1', '老板能否创建管理员账号', '应被拒', `被拒 code=${r1.code} ${r1.message}`, '✅ 已拦住', '')
  }

  // ============================================================
  // R2：老板能否把 admin 降级 —— 只读源码结论，不实际复现
  // ============================================================
  record('R2', '老板能否把系统管理员 admin 降级为普通员工',
    '应被拒（不能剥夺别人/唯一管理员的 admin 角色）',
    '源码结论：updateRole 只有「禁止授予自己不具备的 admin」这一道边界；' +
    '「剥夺」方向无校验；且 isLastActiveManager 把 boss 也算作管理账号（MANAGEMENT_ROLES=[admin,boss]），' +
    '所以只要系统里还有任一 boss 角色账号，保护就不触发 → 降级会成功',
    '❌ 漏洞成立（P0）· 未实际复现（见文末说明）',
    '源码 src/modules/user.js:144-190 + src/middleware/auth.js:93')

  // ============================================================
  // R3：直接入库单价填 0 是否被拦
  // ============================================================
  const r3 = await call('inbound', 'submit', {
    warehouse_id: 1, type: 'purchase', supplier: '【复核】供应商',
    remark: '[V3-RECHECK] 单价 0 复核',
    items: [{ material_id: MAT._id, material_name: MAT.name, quantity: 1, unit_price: 0 }]
  }, T.sk, `recheck-r3-${uniq}`)

  if (r3.code === 0) {
    const inId = r3.data._id || r3.data.id
    await call('inbound', 'cancel', { id: inId, reason: '[V3-RECHECK] 复核后作废' }, T.sk)
    record('R3', '直接入库把单价填 0，系统是否拦住',
      '应被拒（0 会让这批货入库成本变成 0，库存账失真；采购录入那边已经禁止 0）',
      `提交成功 code=0（入库单 ${r3.data.order_no || inId}），已作废回退库存`,
      '❌ 漏洞成立（P1）· 与 purchase.entry 的「单价必须>0」不一致',
      `POST /api/inbound {action:"submit", unit_price:0} → ${JSON.stringify(r3).slice(0, 110)}`)
  } else {
    record('R3', '入库单价 0 是否被拦', '应被拒', `被拒 code=${r3.code} ${r3.message}`, '✅ 已拦住', '')
  }

  // ============================================================
  // R4：仓管能否查看本仓、别人建的盘点单
  // ============================================================
  const bossCheck = await call('check', 'list', { pageSize: 50 }, T.boss)
  const skCheckList = await call('check', 'list', { pageSize: 50 }, T.sk)
  const bossIds = new Set(((bossCheck.data && bossCheck.data.list) || []).map((x) => Number(x._id ?? x.id)))
  const skIds = new Set(((skCheckList.data && skCheckList.data.list) || []).map((x) => Number(x._id ?? x.id)))
  // 老板建过、而仓管列表里没有的（= 老板在成品仓建的，仓管本该能看到）
  const onlyBoss = [...bossIds].filter((i) => !skIds.has(i))

  let r4detail = '仓管列表里没有「只有老板能见到」的盘点单，无法构造该场景'
  let r4verdict = '⚠️ 未能构造'
  if (onlyBoss.length) {
    const probe = await call('check', 'detail', { id: onlyBoss[0] }, T.sk)
    r4detail = probe.code === 0
      ? `仓管能看到盘点单 ${onlyBoss[0]} 的详情`
      : `仓管看不到（code=${probe.code}：${probe.message}），但该单属于他管的仓库`
  }
  const skListCount = skIds.size
  record('R4', '仓管能否查看「本仓、别人（老板）创建」的盘点单',
    '应该能（这一轮的 list 已修成仓管可见本仓全部，详情应该一致）',
    `仓管可见盘点单 ${skListCount} 张；老板建的、仓管列表里看不到的有 ${onlyBoss.length} 张 → ${r4detail}`,
    onlyBoss.length ? (r4detail.includes('看不到') ? '❌ 成立（P1）：列表和详情权限不一致，看得见列表点不开详情' : '✅ 详情也可看') : '⚠️ 未能构造',
    '源码 src/modules/check.js: assertCheckVisible 只对 boss/admin 放行，仓管需「自己创建或参与」')

  // ============================================================
  // R5：material.upsert 是否接受不存在的仓库
  // ============================================================
  const r5name = `【复核】幽灵仓物料${uniq}`
  const r5 = await call('material', 'upsert', {
    name: r5name, spec: `RECHECK-${uniq}`, unit: '个',
    category: '配件', warehouse_id: 999, warning_stock: 1
  }, T.admin)

  if (r5.code === 0) {
    await call('material', 'delete', { id: r5.data._id }, T.admin)
    record('R5', '新建物料时传一个不存在的仓库 id（999），系统是否拦住',
      '应被拒（否则会产生不属于任何仓库的「孤儿物料」，污染统计）',
      `创建成功 code=0（id=${r5.data._id}，warehouse_id=999），已删除`,
      '❌ 漏洞成立（P1）',
      `POST /api/material {action:"upsert", warehouse_id:999} → ${JSON.stringify(r5).slice(0, 110)}`)
  } else {
    record('R5', '不存在的仓库是否被拦', '应被拒', `被拒 code=${r5.code} ${r5.message}`, '✅ 已拦住', '')
  }

  // ============================================================
  // R6：出库「拆行」能否绕过库存校验
  // ============================================================
  const detail = await call('material', 'detail', { id: MAT._id }, T.sk)
  const stockNow = Number((detail.data && detail.data.current_stock) || 0)
  const half = Math.max(1, Math.floor(stockNow / 2) + 1)   // 每行都超一半 → 两行合计超总量
  const r6 = await call('outbound', 'submit', {
    warehouse_id: 1, type: 'lingyong', remark: '[V3-RECHECK] 拆行绕过复核',
    items: [
      { material_id: MAT._id, material_name: MAT.name, quantity: half, warehouse_id: 1 },
      { material_id: MAT._id, material_name: MAT.name, quantity: half, warehouse_id: 1 }
    ]
  }, T.out, `recheck-r6-${uniq}`)

  if (r6.code === 0) {
    await call('outbound', 'cancel', { id: r6.data._id }, T.out)
    record('R6', `同一物料分两行、每行 ${half} 个（合计 ${half * 2} > 库存 ${stockNow}）能否提交`,
      '应被拒（合计超库存）',
      `提交成功 code=0（单号 ${r6.data.order_no}），已撤销`,
      '❌ 漏洞成立（P1）：逐行校验而非合并校验，拆行可绕过',
      `POST /api/outbound {action:"submit"} 两行同物料各 ${half}，库存仅 ${stockNow}`)
  } else {
    record('R6', '拆行是否绕过库存校验', '应被拒',
      `被拒 code=${r6.code} ${r6.message}`, '✅ 已拦住（说明系统会合并校验）', '')
  }

  // ============================================================
  console.log('\n\n════════ 复核汇总 ════════')
  console.log('编号 | 结论 | 标题')
  console.log('-'.repeat(78))
  for (const r of results) {
    const mark = r.verdict.startsWith('❌') ? '漏洞' : r.verdict.startsWith('✅') ? '通过' : '未构造'
    console.log(`${r.id.padEnd(4)} | ${mark.padEnd(4)} | ${r.title}`)
  }
  const holes = results.filter((r) => r.verdict.startsWith('❌')).length
  console.log('-'.repeat(78))
  console.log(`复核 ${results.length} 条，其中漏洞 ${holes} 条，通过 ${results.filter((r) => r.verdict.startsWith('✅')).length} 条`)

  console.log(`
────────────────────────────────────────────────────────────
关于 R2 为什么不做实际复现：

  把 admin 降级后，系统里就**没有任何 admin 角色**了。
  而「授予 admin」有边界（只有 admin 能授予）——恢复路径只剩
  「用 R1 那个漏洞（user.create 无边界）再造一个 admin」。
  也就是说：一旦复现，能否恢复取决于另一个漏洞是否还在。

  复核的目的不是把系统弄坏，所以这条**只给源码级根因**：
    · src/modules/user.js:144   updateRole 只拦「授予」，不拦「剥夺」
    · src/middleware/auth.js:93 MANAGEMENT_ROLES = ['admin','boss']
      → isLastActiveManager 认为 boss 也算管理账号，
        系统只要还有任一 boss，就把「唯一管理员要被摘掉」判定为安全
  两个岗位 Agent 已各自实测复现过一次（返回 code=0，角色真的被改），
  并都利用了 R1 那个漏洞把 admin 恢复回来。
────────────────────────────────────────────────────────────`)

  require('fs').writeFileSync(
    require('path').join(__dirname, 'v3-p0-recheck-result.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2), 'utf8'
  )
  process.exit(0)
})().catch((e) => { console.error('复核脚本异常：', e.message); process.exit(1) })
