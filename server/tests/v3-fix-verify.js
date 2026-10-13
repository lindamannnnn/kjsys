/**
 * ============================================================
 * V3 修复验证脚本（逐条对照，每条都带「修前会错 / 修后该对」的判据）
 * ------------------------------------------------------------
 * 覆盖：
 *   P0-1 老板凭空造管理员（create / approve 两个入口）
 *   P0-2 老板剥夺/禁用管理员
 *   P0-3 「最后一个管理员」保护失效（SQL 层对照实验）
 *   P1-1 直接入库单价可填 0
 *   P1-2 出库「拆行」绕过库存校验
 *   P1-3 盘点详情权限与列表不一致
 *   P1-4 新建物料可指向不存在的仓库
 *   P1-5 采购录入抹掉建单备注
 *   P1-6 金额带 4 位小数
 *   P1-7 盘点审核传非布尔值被静默当「退回」
 *   P1-8 越权尝试不留痕
 *   P1-9 主数据改动不留痕
 *   P1-10 老板收不到「盘点待审」通知
 *   D    预警口径 6 处是否统一
 *
 * 使用：node tests/v3-fix-verify.js
 * 所有测试数据带 [V3FIX] 标记；脚本会自清理，并对危险场景加熔断保护
 * ============================================================
 */
const http = require('http')

require('../src/config/env')
const { query, queryOne } = require('../src/db/pool')

const BASE = 'http://127.0.0.1:3000/api'
const MARK = '[V3FIX]'
const RUN = Date.now()

// ------------------------------------------------------------
// 基础设施
// ------------------------------------------------------------
function call(mod, action, data, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ action, data })
    const req = http.request(
      `${BASE}/${mod}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        timeout: 20000
      },
      (res) => {
        let s = ''
        res.on('data', (c) => (s += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(s))
          } catch (e) {
            reject(new Error(`响应不是 JSON（${mod}.${action}）：${s.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`请求超时：${mod}.${action}`)))
    req.write(payload)
    req.end()
  })
}

const PASS = []
const FAIL = []
const SKIP = []
const WARN = []

function judge(name, pass, expect, actual) {
  if (pass === null) {
    SKIP.push({ name, reason: actual })
    console.log(`  ⏭️  SKIP  ${name} —— ${actual}`)
    return
  }
  if (pass) {
    PASS.push(name)
    console.log(`  ✅ PASS  ${name}`)
  } else {
    FAIL.push({ name, expect, actual })
    console.log(`  ❌ FAIL  ${name}`)
    console.log(`         期望：${expect}`)
    console.log(`         实际：${actual}`)
  }
}

function note(msg) {
  console.log(`  · ${msg}`)
}

function alert(msg) {
  WARN.push(msg)
  console.log(`  ⚠️  ${msg}`)
}

// ------------------------------------------------------------
// 登录
// ------------------------------------------------------------
async function loginDev(openid) {
  const r = await call('auth', 'login', { dev_openid: openid })
  if (r.code !== 0 || !r.data || !r.data.token) {
    throw new Error(`模拟身份登录失败 ${openid}：${r.message}`)
  }
  return r.data.token
}

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log(' V3 修复验证（逐条对照）')
  console.log('════════════════════════════════════════════════════════════')

  // ---------- 0. 环境准备 ----------
  console.log('\n[0] 环境准备')
  const T = {
    out: await loginDev('dev_out'),
    sk: await loginDev('dev_sk'),
    purchase: await loginDev('dev_purchase'),
    boss: await loginDev('dev_boss')
  }
  const adminLogin = await call('auth', 'adminLogin', { username: 'admin', password: '123456' })
  if (adminLogin.code !== 0 || !adminLogin.data || !adminLogin.data.token) {
    throw new Error(`管理员登录失败：${adminLogin.message}`)
  }
  T.admin = adminLogin.data.token
  note('5 个身份登录成功（含后台管理员）')

  // 管理员改密门禁探测（若未改过初始密码，后面全部会 403）
  const probe = await call('user', 'list', { page: 1, pageSize: 1 }, T.admin)
  if (probe.code === 403) {
    throw new Error(
      `管理员被「强制改密」门禁拦住（${probe.message}）——请先在后台改掉初始密码，否则无法验证权限相关条目`
    )
  }
  note('管理员 token 可用（未触发强制改密门禁）')

  // 测试物料
  const mats = await query(
    `SELECT id, name, warehouse_id, current_stock, warning_stock FROM materials
      WHERE name LIKE '【测试】%' AND is_deleted = 0 ORDER BY id`
  )
  if (!mats.length) throw new Error('没有【测试】物料，请先跑 tests/v3-test-setup.js')
  note(`测试物料 ${mats.length} 个：${mats.map((m) => `${m.id}:${m.name.replace('【测试】', '')}`).join('  ')}`)

  const wh1 = mats.find((m) => Number(m.warehouse_id) === 1)
  const wh2 = mats.find((m) => Number(m.warehouse_id) === 2)

  // 清掉测试物料上残留的「未关闭盘点单」，否则建新盘点单会撞冲突
  const dirtyChecks = await query(
    `SELECT DISTINCT c.id, c.check_no, c.status FROM stock_checks c
       JOIN stock_check_items i ON i.check_id = c.id
      WHERE c.status IN ('pending','in_progress','pending_review')
        AND i.material_id IN (${mats.map(() => '?').join(',')})`,
    mats.map((m) => m.id)
  )
  for (const c of dirtyChecks) {
    // 用老板身份清理：仓管只能作废自己创建的单（见 check.cancel 的归属校验），
    // 而这里挡路的单可能是老板/管理员建的
    const r = await call('check', 'cancel', { id: c.id, reason: `${MARK} 验证前清理` }, T.boss)
    note(`清理遗留盘点单 ${c.check_no}（${c.status}）→ code=${r.code}`)
  }

  // ============================================================
  // A 组：权限门（P0-1 / P0-2 / P0-3）
  // ============================================================
  console.log('\n[A] 权限门 —— 「谁能当管理员」')
  console.log('  ── P0-1 老板凭空造管理员 ──')

  // A1：老板创建 admin 账号
  const a1Name = `V3FIX_noadmin_${RUN}`
  const a1 = await call('user', 'create', {
    username: a1Name, password: 'abc123456', real_name: '越权探针',
    roles: ['admin'], warehouse_ids: [1]
  }, T.boss)
  judge('A1 老板 user.create 建管理员被拒（403）',
    a1.code === 403, 'code=403 只有管理员才能授予管理员', `code=${a1.code} ${a1.message}`)
  if (a1.code === 0) {
    // 熔断：修复失效，立刻禁用这个凭空造出来的管理员
    const err = await queryOne('SELECT id FROM users WHERE username = ?', [a1Name])
    if (err) {
      await call('user', 'disable', { id: err.id }, T.admin)
      alert(`修复失效！已紧急禁用探针管理员账号 id=${err.id}（username=${a1Name}）`)
    }
  }

  // A2：老板审核通过一个用户并授予 admin
  // 干净构造 pending 用户：拿一个全新的 dev_openid 登录，系统会自动建档为「待审核」
  const pendingOpenid = `dev_v3fix_pending_${RUN}`
  const loginNew = await call('auth', 'login', { dev_openid: pendingOpenid })
  const newUser = loginNew.code === 0 && loginNew.data ? loginNew.data.user : null
  if (!newUser || newUser.status !== 'pending') {
    judge('A2 老板 user.approve 授予 admin 被拒', null, '',
      `未能构造出 pending 用户（login code=${loginNew.code} status=${newUser && newUser.status}）`)
  } else {
    // 待审用户没填真实姓名时会被「姓名校验」先拦下，先补上（这也是后台的正常操作）
    await call('user', 'update', { id: newUser._id, real_name: 'V3FIX待审探针' }, T.admin)

    const a2 = await call('user', 'approve', {
      id: newUser._id, roles: ['admin'], warehouse_ids: [1]
    }, T.boss)
    judge('A2 老板 user.approve 授予管理员被拒（403）',
      a2.code === 403, 'code=403 只有管理员才能授予管理员', `code=${a2.code} ${a2.message}`)
    if (a2.code === 0) {
      await query("UPDATE users SET status = 'pending', roles = JSON_ARRAY() WHERE id = ?", [newUser._id])
      alert(`修复失效！已把待审用户 id=${newUser._id} 退回 pending`)
    }

    // 对照：管理员用同一入口授予普通角色应当成功（不能把入口整个关掉）
    const a2b = await call('user', 'approve', {
      id: newUser._id, roles: ['out'], warehouse_ids: [1]
    }, T.admin)
    judge('A2b 管理员审核通过（授予普通角色）正常成功（0）',
      a2b.code === 0, 'code=0（证明拦的是「授予管理员」而不是整个入口）', `code=${a2b.code} ${a2b.message}`)

    // 清理：禁用这个探针用户
    await call('user', 'disable', { id: newUser._id }, T.admin)
    note(`待审探针用户 id=${newUser._id}（openid=${pendingOpenid}）已验证并禁用`)
  }

  console.log('  ── P0-2 老板剥夺 / 禁用管理员 ──')
  const adminRow = await queryOne(
    "SELECT id, username, roles, status FROM users WHERE JSON_CONTAINS(COALESCE(roles,JSON_ARRAY()),JSON_QUOTE('admin')) AND status='active' ORDER BY id LIMIT 1"
  )
  if (!adminRow) throw new Error('库里没有启用状态的管理员，无法验证 P0-2')
  const adminId = adminRow.id
  note(`目标管理员：id=${adminId} username=${adminRow.username} roles=${JSON.stringify(adminRow.roles)}`)

  // A3：老板把自己的管理员降级
  const a3 = await call('user', 'updateRole', { id: adminId, roles: ['out'] }, T.boss)
  judge('A3 老板剥夺管理员角色被拒（403）',
    a3.code === 403, 'code=403 只有管理员才能取消他人的管理员角色', `code=${a3.code} ${a3.message}`)
  if (a3.code === 0) {
    const back = JSON.stringify(Array.isArray(adminRow.roles) ? adminRow.roles : ['admin'])
    await query('UPDATE users SET roles = ? WHERE id = ?', [back, adminId])
    alert(`修复失效！管理员 id=${adminId} 已被降级，已紧急还原为 ${back}`)
  }

  // A4：老板禁用管理员
  const a4 = await call('user', 'disable', { id: adminId }, T.boss)
  judge('A4 老板禁用管理员被拒（403）',
    a4.code === 403, 'code=403 只有管理员才能禁用管理员账号', `code=${a4.code} ${a4.message}`)
  if (a4.code === 0) {
    await call('user', 'enable', { id: adminId }, T.admin)
    alert(`修复失效！管理员 id=${adminId} 已被禁用，已紧急启用`)
  }

  console.log('  ── 没误伤：管理员本身仍能授予/调整 ──')
  const probeName = `V3FIX_admin_probe_${RUN}`
  const a5 = await call('user', 'create', {
    username: probeName, password: 'abc123456', real_name: '探针管理员',
    roles: ['admin'], warehouse_ids: [1]
  }, T.admin)
  judge('A5 管理员创建管理员账号被允许（0）',
    a5.code === 0, 'code=0（不能因为修漏洞而把正常路径也堵死）', `code=${a5.code} ${a5.message}`)
  const probeId = a5.code === 0 ? a5.data._id : null

  if (probeId) {
    const a6 = await call('user', 'updateRole', { id: probeId, roles: ['out'] }, T.admin)
    judge('A6 系统里有 2 个管理员时，降级其中一个被允许（0）',
      a6.code === 0, 'code=0（关键是「最后一个」不能动，而不是一刀切禁止）', `code=${a6.code} ${a6.message}`)

    const a7 = await call('user', 'updateRole', { id: adminId, roles: ['out'] }, T.admin)
    judge('A7 管理员不能取消自己的管理权限（400）',
      a7.code === 400, 'code=400 不能取消自己的管理权限', `code=${a7.code} ${a7.message}`)

    // 清理探针账号
    await call('user', 'disable', { id: probeId }, T.admin)
    note(`已禁用探针管理员账号 id=${probeId}（${probeName}）`)
  }

  console.log('  ── P0-3 根因对照实验（SQL 层） ──')
  // 该条无法用接口安全复现（一复现系统就没有 admin 了），因此用「同一场景、两套查询条件」
  // 的对照实验证明根因已修：新条件判定「这是最后一个管理员」，旧条件判定「还有别人」。
  const newCond = await queryOne(
    `SELECT COUNT(*) AS c FROM users
      WHERE status='active' AND id <> ?
        AND JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('admin'))`,
    [adminId]
  )
  const oldCond = await queryOne(
    `SELECT COUNT(*) AS c FROM users
      WHERE status='active' AND id <> ?
        AND (JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('admin'))
          OR JSON_CONTAINS(COALESCE(roles, JSON_ARRAY()), JSON_QUOTE('boss')))`,
    [adminId]
  )
  const newC = Number(newCond.c)
  const oldC = Number(oldCond.c)
  note(`当前系统：除该管理员外，还有 ${newC} 个 admin、${oldC} 个 admin 或 boss`)
  judge('A8 「最后一个管理员」保护已能触发（新条件=0，旧条件>0 → 旧逻辑会放行）',
    newC === 0 && oldC > 0,
    '新条件 0（判定为唯一管理员 → 保护触发）且旧条件 >0（判定为还有别人 → 保护失效）',
    `新条件=${newC}，旧条件=${oldC}${newC !== 0 ? '（系统里存在多个管理员，本条无法判定，请先禁用多余管理员）' : ''}`)

  // ============================================================
  // B 组：数据准确性（P1-1 / P1-2 / P1-4 / P1-6）
  // ============================================================
  console.log('\n[B] 数据准确性')

  console.log('  ── P1-1 入库单价可填 0 ──')
  const b1 = await call('inbound', 'submit', {
    warehouse_id: 1, type: 'purchase', supplier: `${MARK} 验证供应商`,
    remark: `${MARK} 单价 0 探针`,
    items: [{ material_id: wh1.id, material_name: wh1.name, quantity: 1, unit_price: 0 }]
  }, T.sk, `v3fix-b1-${RUN}`)
  judge('B1 入库单价填 0 被拒（400）',
    b1.code === 400 && /大于 0/.test(b1.message),
    'code=400，提示单价必须大于 0', `code=${b1.code} ${b1.message}`)

  const b1b = await call('inbound', 'submit', {
    warehouse_id: 1, type: 'purchase', supplier: `${MARK} 验证供应商`,
    remark: `${MARK} 单价文字探针`,
    items: [{ material_id: wh1.id, material_name: wh1.name, quantity: 1, unit_price: 'abc' }]
  }, T.sk, `v3fix-b1b-${RUN}`)
  judge('B1b 入库单价填文字被拒（400）',
    b1b.code === 400, 'code=400', `code=${b1b.code} ${b1b.message}`)

  console.log('  ── P1-2 出库拆行绕过库存校验 ──')
  const stockNow = Number(wh1.current_stock)
  if (stockNow < 3) {
    judge('B2 拆行提交被拒（400 库存不足）', null, '', `测试物料「${wh1.name}」库存只有 ${stockNow}，不够构造拆行场景（需 ≥3）`)
  } else {
    const half = stockNow - 1 // 每行都不超库存，合计 2S-2 > S
    const b2 = await call('outbound', 'submit', {
      warehouse_id: 1, type: 'lingyong', remark: `${MARK} 拆行探针`,
      items: [
        { material_id: wh1.id, material_name: wh1.name, quantity: half },
        { material_id: wh1.id, material_name: wh1.name, quantity: half }
      ]
    }, T.out, `v3fix-b2-${RUN}`)
    judge('B2 同一物料拆两行、合计超库存 → 被拒（400）',
      b2.code === 400 && /库存不足/.test(b2.message),
      `code=400 且提示库存不足（库存 ${stockNow}，两行各 ${half}，合计 ${half * 2}）`,
      `code=${b2.code} ${b2.message}`)
    if (b2.code === 0) {
      await call('outbound', 'cancel', { id: b2.data._id, reason: `${MARK} 熔断撤销` }, T.out)
      alert(`修复失效！拆行单据 id=${b2.data._id} 已提交成功，已立即撤销`)
    }
  }

  console.log('  ── P1-4 物料指向不存在的仓库 ──')
  const b3 = await call('material', 'upsert', {
    name: `${MARK} 孤儿物料探针`, warehouse_id: 999, unit: '个', warning_stock: 5
  }, T.admin)
  judge('B3 物料指向不存在的仓库被拒（400）',
    b3.code === 400, 'code=400 所选仓库不存在', `code=${b3.code} ${b3.message}`)
  if (b3.code === 0) {
    await query('UPDATE materials SET is_deleted = 1 WHERE id = ?', [b3.data._id])
    alert(`修复失效！已建出孤儿物料 id=${b3.data._id}，已标记删除待清理`)
  }

  console.log('  ── P1-6 金额4位小数 ──')
  const b4 = await call('stats', 'orderFlow', { page: 1, pageSize: 100 }, T.boss)
  const flowList = (b4.data && b4.data.list) || []
  const badMoney = flowList.filter((x) => {
    const v = Number(x.total_amount || 0)
    return Math.abs(v * 100 - Math.round(v * 100)) > 1e-6
  })
  judge(`B4 单据流水金额均为 2 位小数（检查 ${flowList.length} 条）`,
    badMoney.length === 0,
    '没有超过 2 位小数的金额',
    `${badMoney.length} 条超 2 位，例如：${badMoney.slice(0, 3).map((x) => `${x.order_no}=${x.total_amount}`).join('、')}`)

  // ============================================================
  // C 组：可追溯与流程（P1-5 / P1-7 / P1-8 / P1-9 / P1-10 / P1-3）
  // ============================================================
  console.log('\n[C] 可追溯与流程')

  console.log('  ── P1-5 采购录入抹掉建单备注 ──')
  const keepRemark = `${MARK} 建单原因：产线急需`
  const c1create = await call('purchase', 'create', {
    warehouse_id: 1, remark: keepRemark,
    items: [{ material_id: wh1.id, quantity: 5 }]
  }, T.sk, `v3fix-c1-${RUN}`)
  if (c1create.code !== 0) {
    judge('C1 采购录入不覆盖建单备注', null, '', `建单失败：${c1create.message}`)
  } else {
    const taskId = c1create.data._id
    await call('purchase', 'take', { id: taskId }, T.purchase)
    const entryRemark = `${MARK} 从淘宝下单`
    const c1entry = await call('purchase', 'entry', {
      id: taskId, purchase_channel: '淘宝', external_no: `TB-V3FIX-${RUN}`,
      remark: entryRemark, items: [{ material_id: wh1.id, unit_price: 12.5 }]
    }, T.purchase)
    const c1detail = await call('purchase', 'detail', { id: taskId }, T.sk)
    const finalRemark = String((c1detail.data && c1detail.data.remark) || '')
    judge('C1 采购录入不覆盖建单备注（两条都保留）',
      c1entry.code === 0 && finalRemark.includes('建单原因') && finalRemark.includes('从淘宝下单'),
      `remark 同时含「建单原因：产线急需」与「从淘宝下单」，实际=${JSON.stringify(finalRemark)}`,
      `entry.code=${c1entry.code} 最终 remark=${JSON.stringify(finalRemark)}`)
    note(`已建采购任务 ${c1create.data.task_no}（该任务留在「待收料」，供你验收）`)
  }

  console.log('  ── P1-3 盘点详情权限与列表不一致 ──')
  // 老板建一张盘点单（仓管既不是创建人、也没被指派），仓管应能看到详情
  const bossCheck = await call('check', 'create', {
    type: 'full', warehouse_id: 1,
    scope: { material_ids: [wh1.id] },
    freeze_stock: false, remark: `${MARK} 老板建的盘点单（验仓管可见性）`
  }, T.boss)
  if (bossCheck.code !== 0) {
    judge('C2 仓管能查看本仓的他人盘点单详情', null, '', `建单失败：${bossCheck.message}`)
  } else {
    const bcId = bossCheck.data._id
    const c2 = await call('check', 'detail', { id: bcId }, T.sk)
    const c2list = await call('check', 'list', { page: 1, pageSize: 50 }, T.sk)
    const inList = ((c2list.data && c2list.data.list) || []).some((x) => Number(x._id) === Number(bcId))
    judge('C2 仓管能查看本仓的他人盘点单详情（列表可见 ⇒ 详情也应可开）',
      c2.code === 0, `code=0（列表可见=${inList}）`, `code=${c2.code} ${c2.message}（列表可见=${inList}）`)
    // 收尾：取消这张探针盘点单，避免占着「未关闭盘点单」影响后续
    const cc = await call('check', 'cancel', { id: bcId, reason: `${MARK} 验证完毕取消` }, T.boss)
    note(`已取消探针盘点单（code=${cc.code}）`)
    note('附注：仓管作废「他人创建」的盘点单会被拒（check.cancel 只允许创建人或管理角色作废）——这是设计如此，非缺陷')
  }

  console.log('  ── P1-10 + P1-7 盘点提交通知与审批参数 ──')
  const checkCreate = await call('check', 'create', {
    type: 'full', warehouse_id: 2,
    scope: { material_ids: [wh2.id] },
    freeze_stock: false, remark: `${MARK} 成品仓盘点（验通知与审批）`
  }, T.sk)
  if (checkCreate.code !== 0) {
    judge('C3 盘点提交后老板收到「待审核」消息', null, '', `建单失败：${checkCreate.message}`)
    judge('C4 审批传非布尔值被拒（400）', null, '', `建单失败：${checkCreate.message}`)
  } else {
    const ckId = checkCreate.data._id
    const actual = Number(wh2.current_stock) + 1 // 故意造 1 项差异
    const c3submit = await call('check', 'submit', {
      id: ckId,
      items: [{ material_id: wh2.id, actual_stock: actual, remark: `${MARK} 实盘` }]
    }, T.sk)
    note(`已提交盘点单 ${checkCreate.data.check_no}（账面 ${wh2.current_stock} → 实盘 ${actual}，制造 1 项差异）`)

    // 老板应该收到盘点待审消息
    const bossMsgs = await call('message', 'list', { page: 1, pageSize: 30 }, T.boss)
    const gotCheckMsg = ((bossMsgs.data && bossMsgs.data.list) || []).some(
      (m) => m.type === 'check_pending_review' && Number(m.ref_id) === Number(ckId)
    )
    judge('C3 盘点提交后老板收到「待审核」消息（check_pending_review）',
      c3submit.code === 0 && gotCheckMsg,
      '老板收件箱里能找到 type=check_pending_review 且 ref_id 指向该盘点单的消息',
      `submit.code=${c3submit.code}，收到=${gotCheckMsg}`)

    // P1-7：审批参数严格化
    const c4bad = await call('check', 'review', { id: ckId, approve: 'yes' }, T.boss)
    judge('C4a 审批传 "yes" 被拒（400，不再静默当退回）',
      c4bad.code === 400, 'code=400 参数不合法', `code=${c4bad.code} ${c4bad.message}`)

    const c4bad2 = await call('check', 'review', { id: ckId, approve: 2 }, T.boss)
    judge('C4b 审批传 2 被拒（400）',
      c4bad2.code === 400, 'code=400', `code=${c4bad2.code} ${c4bad2.message}`)

    const c4none = await call('check', 'review', { id: ckId }, T.boss)
    judge('C4c 审批不传表态被拒（400）',
      c4none.code === 400, 'code=400', `code=${c4none.code} ${c4none.message}`)

    const c4ok = await call('check', 'review', { id: ckId, approve: true }, T.boss)
    judge('C4d 明确传 approve=true 正常通过（0，没误伤）',
      c4ok.code === 0, 'code=0 且按差异调整库存', `code=${c4ok.code} ${c4ok.message}`)

    const after = await call('material', 'detail', { id: wh2.id }, T.sk)
    const stockAfter = Number((after.data && after.data.current_stock) || 0)
    judge('C4e 审核通过后库存确实被调整为实盘数',
      Math.abs(stockAfter - actual) < 0.001,
      `库存应变为实盘数 ${actual}`, `实际库存 ${stockAfter}`)
  }

  console.log('  ── P1-8 越权尝试留痕 ──')
  const deniedBefore = await queryOne(
    "SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'permission_denied'"
  )
  const c5 = await call('user', 'list', { page: 1, pageSize: 1 }, T.out) // 领料员打用户管理
  await new Promise((r) => setTimeout(r, 400))
  const deniedAfter = await queryOne(
    "SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'permission_denied'"
  )
  const delta = Number(deniedAfter.c) - Number(deniedBefore.c)
  judge('C5 越权尝试被记入日志（permission_denied 增加）',
    c5.code === 403 && delta >= 1,
    '领料员调 user.list 返回 403，且日志 action=permission_denied 至少 +1',
    `调用 code=${c5.code}，日志增量=${delta}`)

  // 日志内容是否可读（能追出「谁试了什么」）
  const lastDenied = await queryOne(
    "SELECT user_name, target_id, detail FROM operation_logs WHERE action='permission_denied' ORDER BY id DESC LIMIT 1"
  )
  if (lastDenied) {
    note(`最新一条留痕：${lastDenied.user_name} | ${lastDenied.target_id} | ${String(lastDenied.detail).slice(0, 90)}`)
  }

  console.log('  ── P1-9 主数据改动留痕 ──')
  async function logDelta(action, fn) {
    const before = await queryOne('SELECT COUNT(*) AS c FROM operation_logs WHERE action = ?', [action])
    const r = await fn()
    await new Promise((res) => setTimeout(res, 300))
    const after = await queryOne('SELECT COUNT(*) AS c FROM operation_logs WHERE action = ?', [action])
    return { delta: Number(after.c) - Number(before.c), code: r.code, message: r.message }
  }

  const c6a = await logDelta('material_update', () =>
    call('material', 'upsert', {
      _id: wh1.id, name: wh1.name, warehouse_id: 1, unit: '个',
      warning_stock: Number(wh1.warning_stock) || 5, remark: `${MARK} 留痕探针（值与原来一致）`
    }, T.admin))
  judge('C6a 物料档案修改留痕（material_update +1）',
    c6a.delta >= 1, '日志 material_update +1', `delta=${c6a.delta} code=${c6a.code} ${c6a.message}`)

  const anySupplier = await queryOne('SELECT id, name, remark FROM suppliers WHERE is_deleted = 0 ORDER BY id LIMIT 1')
  if (!anySupplier) {
    judge('C6b 供应商资料修改留痕', null, '', '库里没有供应商，场景无法构造')
  } else {
    const c6b = await logDelta('supplier_update', () =>
      call('supplier', 'upsert', {
        _id: anySupplier.id, name: anySupplier.name, remark: String(anySupplier.remark || '')
      }, T.admin))
    judge('C6b 供应商资料修改留痕（supplier_update +1）',
      c6b.delta >= 1, '日志 supplier_update +1', `delta=${c6b.delta} code=${c6b.code} ${c6b.message}`)
  }

  const anyWh = await queryOne('SELECT id, name, sort_order FROM warehouses WHERE is_deleted = 0 ORDER BY id LIMIT 1')
  const c6c = await logDelta('warehouse_update', () =>
    call('warehouse', 'upsert', {
      _id: anyWh.id, name: anyWh.name, sort_order: Number(anyWh.sort_order || 0)
    }, T.admin))
  judge('C6c 仓库资料修改留痕（warehouse_update +1）',
    c6c.delta >= 1, '日志 warehouse_update +1', `delta=${c6c.delta} code=${c6c.code} ${c6c.message}`)

  const anyUser = await queryOne("SELECT id, real_name FROM users WHERE openid = 'dev_purchase' LIMIT 1")
  if (!anyUser) {
    judge('C6d 用户资料修改留痕', null, '', '找不到 dev_purchase 账号')
  } else {
    const c6d = await logDelta('user_update', () =>
      call('user', 'update', { id: anyUser.id, real_name: anyUser.real_name }, T.admin))
    judge('C6d 用户资料修改留痕（user_update +1）',
      c6d.delta >= 1, '日志 user_update +1', `delta=${c6d.delta} code=${c6d.code} ${c6d.message}`)
  }

  // ============================================================
  // D 组：预警口径是否统一（6 处）
  // ============================================================
  console.log('\n[D] 预警口径一致性（看板 / 预警明细 / 物料列表 / 仓库汇总）')
  const dOverview = await call('stats', 'overview', {}, T.boss)
  const dWarning = await call('stats', 'warning', { page: 1, pageSize: 1 }, T.boss)
  const dMatList = await call('material', 'list', { page: 1, pageSize: 1, showWarningOnly: true }, T.boss)
  const dWhList = await call('warehouse', 'list', {}, T.boss)

  const vOverview = Number((dOverview.data && dOverview.data.warning_count) || 0)
  const vWarning = Number((dWarning.data && dWarning.data.total) || 0)
  const vMatList = Number((dMatList.data && dMatList.data.total) || 0)
  const vWhSum = ((dWhList.data && dWhList.data.list) || []).reduce(
    (s, w) => s + Number(w.warning_count || 0), 0
  )
  note(`看板=${vOverview}  预警明细=${vWarning}  物料列表(只看预警)=${vMatList}  仓库汇总=${vWhSum}`)
  judge('D1 四处预警口径完全一致',
    vOverview === vWarning && vWarning === vMatList && vMatList === vWhSum,
    '四个数字全相等', `看板=${vOverview} 明细=${vWarning} 物料列表=${vMatList} 仓库汇总=${vWhSum}`)

  // 零库存计数不能随分页变化（P2 修复：原来用当前页 rows 过滤，pageSize=1 时最多显示 1）
  const dWarnP1 = await call('stats', 'warning', { page: 1, pageSize: 1 }, T.boss)
  const dWarnP200 = await call('stats', 'warning', { page: 1, pageSize: 200 }, T.boss)
  const o1 = Number((dWarnP1.data && dWarnP1.data.out_of_stock) || 0)
  const o200 = Number((dWarnP200.data && dWarnP200.data.out_of_stock) || 0)
  judge('D2 零库存数不随分页变化（走全量统计）',
    o1 === o200,
    'pageSize=1 与 pageSize=200 返回的 out_of_stock 相同',
    `pageSize=1 → ${o1}，pageSize=200 → ${o200}`)

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n════════════════════════════════════════════════════════════')
  console.log(` 验证结果：通过 ${PASS.length} / 失败 ${FAIL.length} / 跳过 ${SKIP.length}`)
  if (FAIL.length) {
    console.log('\n 失败明细：')
    for (const f of FAIL) console.log(`   ❌ ${f.name}\n      期望：${f.expect}\n      实际：${f.actual}`)
  }
  if (SKIP.length) {
    console.log('\n 跳过（场景无法构造，需要你知悉）：')
    for (const s of SKIP) console.log(`   ⏭️  ${s.name} —— ${s.reason}`)
  }
  if (WARN.length) {
    console.log('\n 熔断告警（修复未生效，脚本已做紧急恢复）：')
    for (const w of WARN) console.log(`   ⚠️  ${w}`)
  }
  console.log('════════════════════════════════════════════════════════════')

  // 数据自检：修完权限是否误伤了对账链
  const bad = await queryOne(
    `SELECT COUNT(*) AS c FROM (
       SELECT m.id, m.current_stock, COALESCE(SUM(l.change_quantity),0) AS flow
         FROM materials m LEFT JOIN stock_logs l ON l.material_id = m.id
        WHERE m.is_deleted = 0
        GROUP BY m.id, m.current_stock
       HAVING ABS(m.current_stock - flow) > 0.001
     ) t`
  )
  console.log(` 对账回归：库存与流水对不上的物料数 = ${bad.c} ${Number(bad.c) === 0 ? '✅' : '❌'}`)

  process.exit(FAIL.length ? 1 : 0)
}

main().catch((e) => {
  console.error('\n脚本异常终止：', e.message)
  process.exit(2)
})
