/**
 * 第二批验收：后台「按角色隔离」+ 物料照片上传权限
 * ============================================================
 * 需求（2026-10-09 用户提）：
 *   「配件仓 / 成品仓后台 + 厂长后台 —— 注意权限问题，只能够登入自己对应的后台，
 *     功能跟小程序上的功能完全重合就行」
 *   「仓库后台字段 显示出该物料照片」（顺带做上传）
 *
 * 本套件回答的核心问题只有一个：
 *   **菜单里给出的入口，点进去是不是真能用？**（而不是「能不能渲染」）
 *
 * 判据分四段：
 *   A 一致性 —— admin/src/constants/menu.js 里出现的每个菜单路径都必须在
 *              page-matrix.json 里登记；角色名必须是合法角色。
 *   B 正向   —— 对 page-matrix 里每个页面、每个声明允许的角色，逐一真实登录调用
 *              该页 `must` 里的每一个后端动作，断言**不出现 403**。
 *                （写操作一律传 {}，靠参数校验先失败 → 证明「过了角色门、没落库」，
 *                  避免为了测权限反而把真实数据写了）
 *   C 反向   —— 明确点名的越权组合必须被拒（403），证明隔离是真的。
 *   D 照片   —— 真传一张图 → 写进测试物料 → material.list 查得回 → 静态地址真能 200。
 *
 * 用法：
 *   node tests/role-agent/batch2-admin-roles-check.js
 *   node tests/role-agent/batch2-admin-roles-check.js --no-cleanup
 *
 * ⚠️ 会往真实库写：7 个 RA_BK2_* 测试账号 + 1 个测试物料 + 1 个上传文件。
 *    账号名以 RA_ 开头，`tests/cleanup-test-data.js` 认得（username LIKE 'RA_%'）；
 *    物料名以 [RA-BK2] 开头（name LIKE '[RA%'）；上传文件自己在最后删掉。
 */
require('../../src/config/env')

const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')

const { callRaw, loginAdmin } = require('./lib')
const { query, queryOne, execute } = require('../../src/db/pool')
const { autoCleanup } = require('./_cleanup')

const ADMIN_SRC = path.join(__dirname, '..', '..', '..', 'admin', 'src', 'constants')
const MATRIX_PATH = path.join(ADMIN_SRC, 'page-matrix.json')
const MENU_PATH = path.join(ADMIN_SRC, 'menu.js')

/* ---------------------------------------------------------------- 断言框架 */

let pass = 0
const failures = []

function ok(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    failures.push({ label, detail })
    console.log(`  ❌ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

const isForbidden = (res) => !!res && Number(res.code) === 403
const brief = (res) => `code=${res && res.code} ${res && res.message}`

/* ---------------------------------------------------------------- 测试账号 */

const PASSWORD = 'RA_BK2_Pwd_2026'
const PREFIX = 'RA_BK2_'

/**
 * 每个角色一个后台账号。
 * ⚠️ 仓管必须**按仓库分开**两个账号 —— 「配件仓管只看到配件仓」这条需求，
 *    只有窄范围的账号才测得出来（一个 [1,2] 全通的仓管看不出隔离）。
 */
const ACCOUNTS = [
  { key: 'admin', username: `${PREFIX}admin`, roles: ['admin'], warehouseCodes: [] },
  { key: 'boss', username: `${PREFIX}boss`, roles: ['boss'], warehouseCodes: [] },
  { key: 'sk_parts', username: `${PREFIX}sk_parts`, roles: ['storekeeper'], warehouseCodes: ['peijian'] },
  { key: 'sk_goods', username: `${PREFIX}sk_goods`, roles: ['storekeeper'], warehouseCodes: ['chengpin'] },
  { key: 'director', username: `${PREFIX}director`, roles: ['director'], warehouseCodes: ['peijian', 'chengpin'] },
  { key: 'purchase', username: `${PREFIX}purchase`, roles: ['purchase'], warehouseCodes: ['peijian', 'chengpin'] },
  { key: 'out', username: `${PREFIX}out`, roles: ['out'], warehouseCodes: ['peijian'] }
]

/** 用直连数据库造后台账号（走 mysql2，中文才不乱码） */
async function ensureAccounts(warehouseIdByCode) {
  const tokens = {}

  // 先清掉同名残留（上一次跑崩了没清干净的情况）
  await execute(`DELETE FROM users WHERE username LIKE '${PREFIX}%'`)

  const hash = await bcrypt.hash(PASSWORD, 10)

  for (const acc of ACCOUNTS) {
    const whIds = acc.warehouseCodes.map((c) => warehouseIdByCode[c]).filter(Boolean)
    await execute(
      `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, NOW())`,
      [acc.username, hash, `测试·后台${acc.key}`, JSON.stringify(acc.roles), JSON.stringify(whIds)]
    )
  }

  for (const acc of ACCOUNTS) {
    tokens[acc.key] = await loginAdmin(acc.username, PASSWORD)
  }

  return tokens
}

/* ---------------------------------------------------------------- 各角色能做的动作 */

/**
 * 页面 `must` 里的动作 → 调用参数。
 * ⚠️ 写操作统一传 {}：角色门在 app.js 里**先于** action 执行，
 *    所以只要过了门，action 一定会用自己的参数校验返回 400（例如「物料名称不能为空」）。
 *    这样既证明了权限，又不会为了测权限把真实库存/单据写坏。
 */
const CALL_ARGS = {} // 全部用空参数即可，见上面注释

async function probe(token, action) {
  const [mod, act] = String(action).split('.')
  return callRaw(mod, act, CALL_ARGS[action] || {}, token)
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  console.log('# 第二批验收 · 后台按角色隔离 + 物料照片\n')
  const t0 = Date.now()

  /* ---------- 0. 前置：仓库 code → id ---------- */
  const whRows = await query('SELECT id, code, name FROM warehouses WHERE is_deleted = 0')
  const warehouseIdByCode = {}
  whRows.forEach((w) => { warehouseIdByCode[w.code] = w.id })
  ok('缓存库存在 peijian / chengpin 两个仓', !!warehouseIdByCode.peijian && !!warehouseIdByCode.chengpin,
    JSON.stringify(warehouseIdByCode))

  /* ---------- 0. 读前端事实来源 ---------- */
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8')).pages
  const menuJs = fs.readFileSync(MENU_PATH, 'utf8')
  const pages = Object.keys(matrix)
  ok(`page-matrix.json 可读（${pages.length} 个页面）`, pages.length >= 15, `实际 ${pages.length}`)

  const tokens = await ensureAccounts(warehouseIdByCode)
  ok(`造出 ${ACCOUNTS.length} 个后台测试账号并全部登录成功`, Object.keys(tokens).length === ACCOUNTS.length)

  const REAL_MATERIAL = await queryOne(
    'SELECT id, name FROM materials WHERE is_deleted = 0 ORDER BY id ASC LIMIT 1'
  )
  const materialId = REAL_MATERIAL ? (REAL_MATERIAL.id || REAL_MATERIAL._id) : null

  /* ================================================================
   * A. 一致性：菜单文件 与 page-matrix 不能各写一套
   * ================================================================ */
  section('A. 一致性：menu.js 与 page-matrix.json')

  // menu.js 里形如 { path: '/dashboard' } 与 children: ['/x', '/y']
  const menuPaths = new Set()
  menuJs.replace(/\{\s*path:\s*'([^']+)'\s*\}/g, (m, p) => { menuPaths.add(p); return m })
  menuJs.replace(/children:\s*\[([^\]]*)\]/g, (m, inner) => {
    inner.replace(/'([^']+)'/g, (mm, p) => { menuPaths.add(p); return mm })
    return m
  })

  ok('menu.js 能解析出菜单路径', menuPaths.size >= 10, `解析到 ${menuPaths.size} 条`)
  const notInMatrix = [...menuPaths].filter((p) => !matrix[p])
  ok('菜单里的每个路径都在 page-matrix 里登记了',
    notInMatrix.length === 0, notInMatrix.join(', '))

  const validRoles = ['out', 'purchase', 'storekeeper', 'director', 'boss', 'admin']
  const badRoles = []
  pages.forEach((p) => {
    (matrix[p].roles || []).forEach((r) => { if (!validRoles.includes(r)) badRoles.push(`${p}→${r}`) })
  })
  ok('page-matrix 里的角色名都是合法角色', badRoles.length === 0, badRoles.join(', '))

  const noMust = pages.filter((p) => !(matrix[p].must || []).length)
  ok('每个页面都声明了 must（依赖接口）', noMust.length === 0, noMust.join(', '))

  const homePages = Object.keys(matrix).filter((p) => (matrix[p].homeOf || []).length)
  ok('每个角色都有落地首页', ['boss', 'admin', 'storekeeper', 'director', 'purchase']
    .every((r) => homePages.some((p) => matrix[p].homeOf.includes(r))),
  `homeOf 覆盖：${homePages.map((p) => `${p}(${matrix[p].homeOf.join('/')})`).join(' ')}`)

  /* ================================================================
   * B. 正向：页面声明的角色，跑该页 must 接口不能有 403
   * ================================================================ */
  section('B. 正向：菜单给了入口，点进去必须真能用')

  // 角色 → 用哪个测试账号代表它（storekeeper 用「配件仓管」代表）
  const ROLE_TOKEN = {
    admin: tokens.admin,
    boss: tokens.boss,
    storekeeper: tokens.sk_parts,
    director: tokens.director,
    purchase: tokens.purchase,
    out: tokens.out
  }

  for (const page of pages) {
    const meta = matrix[page]
    const roles = meta.roles && meta.roles.length ? meta.roles : validRoles
    const must = meta.must || []

    for (const role of roles) {
      const token = ROLE_TOKEN[role]
      if (!token) { ok(`${page} · ${role} 有可用测试账号`, false, '缺少该角色的测试账号'); continue }

      const forbidden = []
      for (const action of must) {
        const res = await probe(token, action)
        if (isForbidden(res)) forbidden.push(`${action}(${res.message})`)
      }
      ok(`${page} · ${role}：${must.length} 个依赖接口全部可调用`,
        forbidden.length === 0, forbidden.join('；'))
    }
  }

  /* ================================================================
   * C. 反向：明确点名的越权必须被拒
   * ================================================================ */
  section('C. 反向：越权必须被后端挡住（403）')

  async function expectForbidden(label, token, action) {
    const res = await probe(token, action)
    ok(label, isForbidden(res), `期望 403，实际 ${brief(res)}`)
  }
  async function expectAllowed(label, token, action) {
    const res = await probe(token, action)
    ok(label, !isForbidden(res), `期望非 403，实际 ${brief(res)}`)
  }

  // 仓管：能干活，但不能碰系统管理
  await expectAllowed('仓管可以看物料列表（material.list）', tokens.sk_parts, 'material.list')
  await expectAllowed('仓管可以确认出库（outbound.confirm）', tokens.sk_parts, 'outbound.confirm')
  await expectAllowed('仓管可以确认入库（inbound.confirm）', tokens.sk_parts, 'inbound.confirm')
  await expectAllowed('仓管可以发布采购任务（purchase.create）', tokens.sk_parts, 'purchase.create')
  await expectAllowed('仓管可以收料（purchase.receive）', tokens.sk_parts, 'purchase.receive')
  await expectAllowed('仓管可以维护物料档案（material.upsert）', tokens.sk_parts, 'material.upsert')
  await expectAllowed('仓管可以建盘点（check.create）', tokens.sk_parts, 'check.create')
  await expectForbidden('仓管不能进用户管理（user.list）', tokens.sk_parts, 'user.list')
  await expectForbidden('仓管不能新建用户（user.create）', tokens.sk_parts, 'user.create')
  await expectForbidden('仓管不能重置别人的密码（user.resetPassword）', tokens.sk_parts, 'user.resetPassword')
  await expectForbidden('仓管不能看趋势分析（stats.trend）', tokens.sk_parts, 'stats.trend')
  await expectForbidden('仓管不能改仓库（warehouse.upsert）', tokens.sk_parts, 'warehouse.upsert')
  await expectForbidden('仓管不能批量导入物料（material.import）', tokens.sk_parts, 'material.import')
  await expectForbidden('仓管不能审核盘点（check.review）', tokens.sk_parts, 'check.review')
  await expectForbidden('仓管不能看操作日志（user.logs）', tokens.sk_parts, 'user.logs')

  // 厂长：能发采购、能审盘点、能从成品仓出库；不碰入库与采购录入
  await expectAllowed('厂长可以看趋势之外的看板（stats.overview）', tokens.director, 'stats.overview')
  await expectAllowed('厂长可以审盘点（check.review）', tokens.director, 'check.review')
  await expectAllowed('厂长可以发采购单（purchase.create）', tokens.director, 'purchase.create')
  await expectAllowed('厂长可以维护物料档案（material.upsert）', tokens.director, 'material.upsert')
  await expectAllowed('厂长可以看库存台账（stats.stockList）', tokens.director, 'stats.stockList')
  await expectForbidden('厂长不能登记入库（inbound.submit）', tokens.director, 'inbound.submit')
  await expectForbidden('厂长不能确认入库（inbound.confirm）', tokens.director, 'inbound.confirm')
  await expectForbidden('厂长不能替采购录入单价（purchase.entry）', tokens.director, 'purchase.entry')
  await expectForbidden('厂长不能收料（purchase.receive）', tokens.director, 'purchase.receive')
  await expectForbidden('厂长不能看趋势分析（stats.trend）', tokens.director, 'stats.trend')
  await expectForbidden('厂长不能进用户管理（user.list）', tokens.director, 'user.list')
  await expectForbidden('厂长不能批量导入物料（material.import）', tokens.director, 'material.import')

  // 采购员：只管买
  await expectAllowed('采购员可以领任务（purchase.take）', tokens.purchase, 'purchase.take')
  await expectAllowed('采购员可以录单价（purchase.entry）', tokens.purchase, 'purchase.entry')
  await expectAllowed('采购员可以看库存台账（stats.stockList）', tokens.purchase, 'stats.stockList')
  await expectForbidden('采购员不能确认入库（inbound.confirm）', tokens.purchase, 'inbound.confirm')
  await expectForbidden('采购员不能确认出库（outbound.confirm）', tokens.purchase, 'outbound.confirm')
  await expectForbidden('采购员不能建盘点（check.create）', tokens.purchase, 'check.create')
  await expectForbidden('采购员不能改物料档案（material.upsert）', tokens.purchase, 'material.upsert')
  await expectForbidden('采购员不能进用户管理（user.list）', tokens.purchase, 'user.list')

  // 老板：只读（用户纠正过，别改回头）
  await expectAllowed('老板可以看看板（stats.overview）', tokens.boss, 'stats.overview')
  await expectAllowed('老板可以看库存台账（stats.stockList）', tokens.boss, 'stats.stockList')
  await expectAllowed('老板可以看用户名单（user.list）', tokens.boss, 'user.list')
  await expectForbidden('老板不能审盘点（check.review）', tokens.boss, 'check.review')
  await expectForbidden('老板不能登记入库（inbound.submit）', tokens.boss, 'inbound.submit')
  await expectForbidden('老板不能确认出库（outbound.confirm）', tokens.boss, 'outbound.confirm')
  await expectForbidden('老板不能改物料档案（material.upsert）', tokens.boss, 'material.upsert')
  await expectForbidden('老板不能看趋势分析（stats.trend，仅 admin）', tokens.boss, 'stats.trend')
  await expectForbidden('老板不能新建用户（user.create）', tokens.boss, 'user.create')

  // 领料员：只有消息与改密
  await expectAllowed('领料员可以看消息（message.list）', tokens.out, 'message.list')
  await expectAllowed('领料员可以看库存台账（stats.stockList，金额字段已脱敏）', tokens.out, 'stats.stockList')
  await expectForbidden('领料员不能进用户管理（user.list）', tokens.out, 'user.list')
  await expectForbidden('领料员不能看仓库金额汇总（stats.warehouseSummary）', tokens.out, 'stats.warehouseSummary')

  // 新增接口 user.assignees：盘点发起人要能选人
  await expectAllowed('仓管可以拉盘点人员候选（user.assignees）', tokens.sk_parts, 'user.assignees')
  await expectAllowed('厂长可以拉盘点人员候选（user.assignees）', tokens.director, 'user.assignees')
  await expectAllowed('管理员可以拉盘点人员候选（user.assignees）', tokens.admin, 'user.assignees')
  await expectForbidden('采购员拉盘点人员候选被拒（user.assignees）', tokens.purchase, 'user.assignees')

  /* ================================================================
   * D. 物料照片：上传 → 落库 → 查回 → 静态地址真能打开
   * ================================================================ */
  section('D. 物料照片链路（后台显示照片的前提）')

  // 1x1 透明 PNG
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const photoProbeName = '[RA-BK2]物料照片探针'

  // ⚠️ 落盘的文件不会被 cleanup-test-data 清掉（它只管数据库），必须自己记着自己删 ——
  //    每跑一次留两三张小图，久了 uploads/materials 里全是垃圾。
  const uploadedUrls = []

  const upAsStore = await callRaw('upload', 'upload',
    { filename: 'ra-bk2.png', base64: PNG_B64, subdir: 'materials' }, tokens.sk_parts)
  if (upAsStore.data && upAsStore.data.url) uploadedUrls.push(upAsStore.data.url)
  ok('仓管（能维护档案的角色）可以上传照片', !isForbidden(upAsStore), brief(upAsStore))

  const upRes = await callRaw('upload', 'upload',
    { filename: 'ra-bk2.png', base64: PNG_B64, subdir: 'materials' }, tokens.admin)
  ok('上传接口返回可访问地址', upRes.code === 0 && !!(upRes.data && upRes.data.url), brief(upRes))
  const photoUrl = upRes.data && upRes.data.url
  if (photoUrl) uploadedUrls.push(photoUrl)

  // 静态地址必须真能打开（只存字段、打不开图 = 后台永远白框）
  if (photoUrl) {
    const http = require('http')
    const staticRes = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:3000${photoUrl}`, (r) => {
        let n = 0
        r.on('data', (c) => { n += c.length })
        r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], size: n }))
      }).on('error', (e) => resolve({ status: 0, type: '', size: 0, err: e.message }))
    })
    ok('照片的静态地址能打开且是图片', staticRes.status === 200 && /image\//.test(staticRes.type || ''),
      JSON.stringify(staticRes))
  } else {
    ok('照片的静态地址能打开且是图片', false, '上一步没拿到 url')
  }

  // 造一条测试物料并挂上照片
  const whPartsId = warehouseIdByCode.peijian
  const ins = await callRaw('material', 'upsert', {
    name: photoProbeName,
    spec: 'RA-BK2',
    category: '配件',
    unit: '个',
    warehouse_id: whPartsId,
    image_fileid: photoUrl || ''
  }, tokens.admin)
  ok('给测试物料写入照片字段（material.upsert）', ins.code === 0, brief(ins))

  const created = await queryOne(
    'SELECT id, image_fileid FROM materials WHERE name = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1',
    [photoProbeName]
  )
  ok('物料表里确实存下了照片地址', !!created && created.image_fileid === photoUrl,
    created ? `库里=${created.image_fileid}` : '没查到物料')

  const listRes = await callRaw('material', 'list', { keyword: photoProbeName, page: 1, pageSize: 5 }, tokens.sk_parts)
  const hit = ((listRes.data && listRes.data.list) || []).find((m) => m.name === photoProbeName)
  ok('物料列表接口会把照片字段带出来（后台照片列的取数前提）',
    !!hit && hit.image_fileid === photoUrl, hit ? `接口返回=${hit.image_fileid}` : '列表里没找到')

  // 收尾：删掉探针物料与上传的图片文件，别留垃圾
  if (created) {
    const mid = created.id
    await execute('DELETE FROM materials WHERE id = ?', [mid])
    const gone = await queryOne('SELECT id FROM materials WHERE id = ?', [mid])
    ok('探针物料已删除', !gone)
  }
  if (photoUrl) {
    const delRes = await callRaw('upload', 'delete', { url: photoUrl }, tokens.admin)
    ok('上传的测试图片已删除', delRes.code === 0, brief(delRes))
  }
  // 把本轮上传过的文件全部删掉（包括那次「仓管能上传吗」探针留下的图）
  // ⚠️ 路径口径必须和 modules/upload.js 一致：UPLOAD_DIR 环境变量优先，否则 cwd/uploads
  const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')
  let leftOver = 0
  for (const u of uploadedUrls) {
    await callRaw('upload', 'delete', { url: u }, tokens.admin)
    const fsProbe = path.join(uploadDir, String(u).replace(/^\/uploads\//, ''))
    if (fs.existsSync(fsProbe)) leftOver++
  }
  ok('本轮上传的图片文件在磁盘上已全部清掉', leftOver === 0, `还剩 ${leftOver} 个（目录 ${uploadDir}）`)

  /* ================================================================
   * E. 上传接口的权限收敛（顺带补 AUTHZ-01 的一个口子）
   * ================================================================ */
  section('E. 上传接口权限（原来是空 roleRules = 任何登录用户都能传）')

  // 造一个 pending、无角色的账号来验证
  const pendingUsername = `${PREFIX}pending`
  await execute(`DELETE FROM users WHERE username = ?`, [pendingUsername])
  await execute(
    `INSERT INTO users (username, password_hash, real_name, roles, warehouse_ids, status, must_change_password, created_at)
     VALUES (?, ?, '测试·待审核', '[]', '[]', 'pending', 0, NOW())`,
    [pendingUsername, await bcrypt.hash(PASSWORD, 10)]
  )
  // pending 账号登不进后台（adminLogin 会 403），所以这里直接查它的 user 行确认存在
  const pendingRow = await queryOne('SELECT id, status FROM users WHERE username = ?', [pendingUsername])
  ok('造出 pending 测试账号（用于验证上传口子）', !!pendingRow && pendingRow.status === 'pending')
  await expectForbidden('老板不能上传文件（只读角色，无上传入口）', tokens.boss, 'upload.upload')
  await expectAllowed('领料员可以上传（报废单要传照片）', tokens.out, 'upload.upload')
  await expectAllowed('采购员可以上传（采购票据/实物照）', tokens.purchase, 'upload.upload')

  /* ---------- 汇总 ---------- */
  console.log(`\n${'='.repeat(60)}`)
  console.log(`断言：${pass + failures.length}，通过 ${pass}，失败 ${failures.length}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (failures.length) {
    console.log('\n失败明细：')
    failures.forEach((f) => console.log(`  ❌ ${f.label}  ← ${f.detail}`))
  }
  console.log('='.repeat(60))

  autoCleanup()
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error('\n💥 套件异常终止：', err && err.stack ? err.stack : err)
  autoCleanup()
  process.exit(1)
})
