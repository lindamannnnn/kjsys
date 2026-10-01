/**
 * ============================================================
 * 专项验证：防重复提交（连点出双单 / 超时重试出双单）
 * ------------------------------------------------------------
 * 缺陷原文（4 角色使用者测试 P1-1-07）：
 *   出库页快速连点两次「提交」，会产生两张一模一样的出库单，库存扣两遍。
 *
 * 根因有两层，缺一层都堵不住：
 *   ① 前端：miniprogram/src/utils/cloud.js 每次请求都现生成一个
 *      client_request_id —— 等于每次都告诉后端「这是新的一笔」，
 *      后端的幂等机制完全失效。网络超时后用户一点重试同样出双单。
 *   ② 页面：提交过程中没有闩锁、loading 没有 mask，遮罩挡不住点击。
 *
 * 本脚本分两部分验证：
 *   第一部分（前端机制）：直接加载真实的 cloud.js，打桩 uni.request，
 *     验证幂等键「该复用的复用、该作废的作废」。不需要服务器。
 *   第二部分（后端兜底）：真实 HTTP 打真实服务，验证即使前端被绕过，
 *     同一幂等键并发/重复提交也只出一张单。
 *
 * 判据重点不只是「防住了」，还有「没误伤」——
 * 用户真心想连下两笔（幂等键不同）时，必须照常出两张单。
 *
 * 安全护栏（任一不满足直接中止，不碰数据）：
 *   - 只建、只改、只删名称以「【测试】防重」开头的物料
 *   - 真实物料库存/成本必须全 0，且不得有流水
 *
 * 用法：
 *   TEST_BASE=http://127.0.0.1:3000 node tests/duplicate-submit-test.js
 *   KEEP=1 保留测试数据（排查用），默认跑完自动清理
 * ============================================================ */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { query, queryOne, execute, pool } = require('../src/db/pool')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const PRE = '【测试】防重'
const WID = 1 // 配件仓

// ---------------- HTTP 调用（与前端 callCloud 同构） ----------------
function call(moduleName, action, data = {}, token = '', clientRequestId = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      action,
      data,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {})
    })
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const req = http.request(`${BASE}/api/${moduleName}`,
      { method: 'POST', headers, timeout: 25000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`响应非 JSON：${raw.slice(0, 300)}`)) }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(payload)
    req.end()
  })
}

const rid = () => crypto.randomUUID()

// ---------------- 结果记录 ----------------
const results = []
let currentScene = ''

function scene(title) {
  currentScene = title
  console.log(`\n${'─'.repeat(64)}\n▌${title}\n${'─'.repeat(64)}`)
}

function checkTrue(label, cond, extra = '') {
  results.push({ 场景: currentScene, 检查项: label, 结果: cond ? '通过' : '失败' })
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
  return cond
}

function checkEq(label, actual, expected) {
  const ok = Number(actual) === Number(expected)
  results.push({ 场景: currentScene, 检查项: label, 实际: actual, 期望: expected, 结果: ok ? '通过' : '失败' })
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(40)} 实际 ${String(actual).padStart(6)}  期望 ${String(expected).padStart(6)}`)
  return ok
}

/* ============================================================
 * 第一部分：前端幂等键机制（真实 cloud.js + 打桩 uni.request）
 * ============================================================ */

const sent = [] // 记录前端「发出」的请求，由测试控制何时、如何回调

function installUniStub() {
  sent.length = 0
  globalThis.uni = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    request: (opts) => { sent.push(opts) },
    login: () => {},
    showLoading: () => {},
    hideLoading: () => {}
  }
}

async function loadCloudModule() {
  const file = path.join(__dirname, '..', '..', 'miniprogram', 'src', 'utils', 'cloud.js')
  const src = fs.readFileSync(file, 'utf8')
  installUniStub()
  // 用 data URL 直接加载 ESM 源码，确保验证的就是产品代码本身
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`)
  return mod
}

/** 取最近一次发出的请求的幂等键 */
const lastKey = () => sent[sent.length - 1].data.client_request_id

async function runFrontendChecks() {
  scene('第一部分 · 前端幂等键机制（真实 cloud.js 代码）')

  const cloud = await loadCloudModule()
  const mk = (tag) => ({
    items: [{ material_id: 1, quantity: 1 }],
    type: 'lingyong',
    warehouse_id: WID,
    remark: `前端机制验证-${tag}`
  })

  // ---------- 1. 参数完全相同的两次提交，必须复用同一个键 ----------
  // 这正是「连点两下」在协议层的真实样子
  let p1 = cloud.callCloud('outbound', 'submit', mk('A'))
  let p2 = cloud.callCloud('outbound', 'submit', mk('A'))
  const keyA = sent[0].data.client_request_id
  checkTrue('两次相同提交复用同一个幂等键（连点不会变成两笔）',
    sent[0].data.client_request_id === sent[1].data.client_request_id,
    `键=${String(keyA).slice(0, 18)}…`)

  // ---------- 2. 结果未知（网络异常）后重试，仍必须复用同一个键 ----------
  sent[0].fail({ errMsg: 'request:fail timeout' })
  sent[1].fail({ errMsg: 'request:fail timeout' })
  await Promise.all([p1.catch(() => {}), p2.catch(() => {})])

  let p3 = cloud.callCloud('outbound', 'submit', mk('A'))
  checkTrue('网络异常后重试复用同一键（超时重试不会变成两笔）',
    lastKey() === keyA, `键=${String(lastKey()).slice(0, 18)}…`)

  // ---------- 3. 明确成功之后，同样的提交必须是「新的一笔」 ----------
  lastSentSuccess({ code: 0, data: { _id: 1, order_no: 'OUT-TEST' } })
  await p3

  let p4 = cloud.callCloud('outbound', 'submit', mk('A'))
  checkTrue('成功之后再提交使用新键（真下第二单不会被吞）',
    lastKey() !== keyA, `新键=${String(lastKey()).slice(0, 18)}…`)

  // ---------- 4. 明确的业务失败（事务已回滚）之后，重试是新的一笔 ----------
  const keyB = lastKey()
  lastSentSuccess({ code: 400, message: '库存不足' })
  await p4.catch(() => {})

  let p5 = cloud.callCloud('outbound', 'submit', mk('A'))
  checkTrue('业务失败后重试使用新键',
    lastKey() !== keyB, `新键=${String(lastKey()).slice(0, 18)}…`)

  // 收尾：让这个悬挂的请求以成功结束，避免残留
  lastSentSuccess({ code: 0, data: { order_no: 'OUT-TEST-2' } })
  await p5

  // ---------- 5. 参数不同 → 两个键（不能因为「像」就误判重复） ----------
  cloud.callCloud('outbound', 'submit', mk('C1'))
  const keyC1 = lastKey()
  cloud.callCloud('outbound', 'submit', mk('C2'))
  const keyC2 = lastKey()
  checkTrue('参数不同则不共用键（不误伤正常的连续下单）', keyC1 !== keyC2)

  // ---------- 6. 对象键顺序不同，指纹必须相同（稳定序列化） ----------
  cloud.callCloud('outbound', 'submit', { a: 1, b: 2, remark: '顺序验证' })
  const keyOrder1 = lastKey()
  cloud.callCloud('outbound', 'submit', { b: 2, a: 1, remark: '顺序验证' })
  const keyOrder2 = lastKey()
  checkTrue('参数键顺序不同视为同一笔（指纹稳定）', keyOrder1 === keyOrder2)

  // ---------- 7. 后端返回 duplicated 时，数据层要能识别出来 ----------
  const pDup = cloud.callCloud('outbound', 'submit', mk('DUP'))
  lastSentSuccess({ code: 0, data: { _id: 9, order_no: 'OUT-EXIST', duplicated: true } })
  const dupRes = await pDup
  checkTrue('后端标记重复提交时，前端能拿到该标记（好在界面上说清楚）',
    dupRes && dupRes.__duplicated === true)
}

/** 让最近一次发出的请求以「成功响应」结束 */
function lastSentSuccess(body) {
  sent[sent.length - 1].success({ data: body })
}

/* ============================================================
 * 第三部分：端到端对照实验
 * ------------------------------------------------------------
 * 把 uni.request 打桩成「真的发 HTTP 请求」，让真实的 cloud.js
 * 代码直接打真实后端 —— 这就是小程序连点时的完整链路。
 *
 * 然后拿「修复前的代码」（git HEAD 里的那一份）跑同样场景做对照：
 *   - 新版：连点两次 → 1 张单
 *   - 旧版：连点两次 → 2 张单
 * 只有两边结果不同，才能证明判据真的抓得住这个缺陷，
 * 而不是一个「怎么写都能过」的空测试。
 * ============================================================ */

/** 把 uni.request 打桩成真实 HTTP，实现「前端代码 → 真实后端」的完整链路 */
function installRealTransport(token) {
  sent.length = 0
  globalThis.uni = {
    getStorageSync: (k) => (k === 'sl_token' ? token : ''),
    setStorageSync: () => {},
    removeStorageSync: () => {},
    request: (opts) => {
      sent.push(opts)
      const target = String(opts.url).replace(/^https?:\/\/[^/]+/, BASE)
      const u = new URL(target)
      const payload = JSON.stringify(opts.data)
      const headers = Object.assign({}, opts.header || {}, {
        'Content-Length': Buffer.byteLength(payload)
      })
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || 'POST', headers, timeout: opts.timeout || 30000 },
        (res) => {
          let raw = ''
          res.on('data', (c) => (raw += c))
          res.on('end', () => {
            try { opts.success({ statusCode: res.statusCode, data: JSON.parse(raw) }) }
            catch (e) { opts.fail({ errMsg: `响应解析失败：${raw.slice(0, 100)}` }) }
          })
        }
      )
      req.on('error', (e) => opts.fail({ errMsg: String(e.message) }))
      req.on('timeout', () => { req.destroy(); opts.fail({ errMsg: 'timeout' }) })
      req.write(payload)
      req.end()
    }
  }
}

const importCloud = async (src) =>
  import(`data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`)

/**
 * 取「修复前」的 cloud.js 用于对照。
 * 夹具取自 git HEAD，已固化在 tests/fixtures/ 下 —— 这样对照实验
 * 不依赖 git 历史、随时可复现（详见夹具文件头部说明）。
 */
function legacyCloudSource() {
  const file = path.join(__dirname, 'fixtures', 'cloud-before-dedup-fix.js')
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    return null
  }
}

/** 连点两次，返回这单在库里落了几张 */
async function doubleClickOnce(cloud, materialId, name, quantity, remark) {
  const body = {
    type: 'lingyong', warehouse_id: WID, remark,
    items: [{ material_id: materialId, material_name: name, quantity }]
  }
  const [a, b] = await Promise.all([
    cloud.callCloud('outbound', 'submit', body),
    cloud.callCloud('outbound', 'submit', body)
  ])
  const row = await queryOne('SELECT COUNT(*) AS c FROM outbound_orders WHERE remark = ?', [remark])
  const orders = await query(
    'SELECT id FROM outbound_orders WHERE remark = ?', [remark]
  )
  orders.forEach((o) => createdOrderIds.outbound.push(Number(o.id)))
  return {
    count: Number(row.c),
    orderNos: [a && a.order_no, b && b.order_no].filter(Boolean)
  }
}

async function runE2EChecks() {
  scene('第三部分 · 端到端对照实验（真实前端代码 → 真实后端）')

  const mId = await newMaterial('E2E' + Date.now().toString().slice(-6))
  const m = await mat(mId)
  const seed = await must('准备库存（入库 60）', call('inbound', 'submit',
    inboundBody(mId, m.name, 60, 5, '端到端对照：准备库存'), TOKEN, rid()))
  createdOrderIds.inbound.push(Number(seed._id))

  const cloudSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'miniprogram', 'src', 'utils', 'cloud.js'), 'utf8')

  // ---------- 新版：连点两次 ----------
  installRealTransport(TOKEN)
  const cloudNew = await importCloud(cloudSrc)
  const beforeNew = await mat(mId)
  const newRun = await doubleClickOnce(cloudNew, mId, m.name, 2, `端到端对照-新版-${rid().slice(0, 8)}`)
  const afterNew = await mat(mId)

  checkEq('【新版】连点两次只出 1 张单', newRun.count, 1)
  checkEq('【新版】库存只扣 2 件（不是 4 件）', beforeNew.stock - afterNew.stock, 2)
  checkTrue('【新版】两次调用返回同一张单号',
    newRun.orderNos.length === 2 && newRun.orderNos[0] === newRun.orderNos[1],
    newRun.orderNos.join(' / '))

  // ---------- 旧版（修复前的产品代码）：同样连点两次 ----------
  const legacySrc = legacyCloudSource()
  if (!legacySrc) {
    console.log('  ⚠ 取不到 git HEAD 版本，跳过对照（不影响上面的结论）')
    return
  }
  // 旧版的标志：每次请求现生成一个键（这一行就是缺陷本体）
  const isLegacy = legacySrc.indexOf('const client_request_id = `') >= 0
  if (!isLegacy) {
    console.log('  ⚠ git HEAD 里的 cloud.js 已是修复版，对照实验跳过（不影响上面的结论）')
    return
  }

  installRealTransport(TOKEN)
  const cloudLegacy = await importCloud(legacySrc)
  const beforeOld = await mat(mId)
  const oldRun = await doubleClickOnce(cloudLegacy, mId, m.name, 2, `端到端对照-旧版-${rid().slice(0, 8)}`)
  const afterOld = await mat(mId)

  checkEq('【旧版·对照】连点两次出了 2 张单（复现缺陷）', oldRun.count, 2)
  checkEq('【旧版·对照】库存被扣了 4 件（多扣一倍）', beforeOld.stock - afterOld.stock, 4)

  console.log(`\n  对照结论：同一套用例，只换前端实现 ——`)
  console.log(`    旧版（git HEAD）：${oldRun.count} 张单，库存扣 ${beforeOld.stock - afterOld.stock} 件`)
  console.log(`    新版（本次修复）：${newRun.count} 张单，库存扣 ${beforeNew.stock - afterNew.stock} 件`)
}

/* ============================================================
 * 第二部分：后端兜底（真实 HTTP）
 * ============================================================ */

let TOKEN = ''
const createdMaterialIds = []
const createdOrderIds = { inbound: [], outbound: [] }

async function login() {
  for (const pwd of [process.env.ADMIN_PASSWORD || '123456', 'admin123456', '123456']) {
    if (!pwd) continue
    const r = await call('auth', 'adminLogin', { username: 'admin', password: pwd })
    if (r.code === 0 && r.data && r.data.token) {
      TOKEN = r.data.token
      return
    }
  }
  throw new Error('管理员登录失败，无法继续')
}

async function must(label, p) {
  const res = await p
  if (!res || res.code !== 0) {
    throw new Error(`[${label}] 失败：${res && res.message ? res.message : JSON.stringify(res)}`)
  }
  return res.data
}

async function newMaterial(key) {
  const name = `${PRE}${key}`
  const found = await call('material', 'list', { keyword: name, pageSize: 20 }, TOKEN)
  const row = ((found.data && found.data.list) || []).find((x) => x.name === name)
  if (row) {
    createdMaterialIds.push(Number(row._id))
    return Number(row._id)
  }
  const d = await must(`创建物料 ${name}`, call('material', 'upsert', {
    name, spec: `防重-${key}`, unit: '个', material_no: `FF-${key}`,
    category: '配件', sub_category: '防重复提交测试', warehouse_id: WID, warning_stock: 0
  }, TOKEN))
  const id = Number(d._id)
  createdMaterialIds.push(id)
  return id
}

async function mat(id) {
  const d = await must('读取物料', call('material', 'detail', { id }, TOKEN))
  return { stock: Number(d.current_stock || 0), cost: Number(d.avg_cost || 0), name: d.name }
}

/** 直接用 SQL 数这个幂等键落了几张单 —— 比接口返回更接近事实 */
async function countByReqId(table, reqId) {
  const r = await queryOne(`SELECT COUNT(*) AS c FROM ${table} WHERE client_request_id = ?`, [reqId])
  return Number(r.c)
}

/** 数这个幂等键对应的单据在流水里出现了几次（多扣一次账就会多一条） */
async function countLogs(reqId) {
  const r = await queryOne(
    `SELECT COUNT(*) AS c FROM stock_logs
      WHERE material_name LIKE ?
        AND related_order_id IN (
          SELECT order_no FROM outbound_orders WHERE client_request_id = ?
          UNION SELECT order_no FROM inbound_orders WHERE client_request_id = ?
        )`,
    [`${PRE}%`, reqId, reqId]
  )
  return Number(r.c)
}

const outboundBody = (materialId, name, qty, remark) => ({
  type: 'lingyong', warehouse_id: WID, remark,
  items: [{ material_id: materialId, material_name: name, quantity: qty }]
})

const inboundBody = (materialId, name, qty, price, remark, supplier = `${PRE}供应商`, type = 'purchase') => ({
  type, warehouse_id: WID, remark, supplier,
  items: [{ material_id: materialId, material_name: name, quantity: qty, unit_price: price }]
})

async function runBackendChecks() {
  scene('第二部分 · 后端兜底（真实 HTTP 请求）')

  // ---------- 准备：一个库存充足的测试物料 ----------
  const mOutId = await newMaterial('OU' + Date.now().toString().slice(-6))
  const mOut = await mat(mOutId)
  // 入库提交即改库存，不需要再走确认
  const seedIn = await must('准备库存（入库 100）', call('inbound', 'submit',
    inboundBody(mOutId, mOut.name, 100, 10, '防重验证：准备库存'), TOKEN, rid()))
  createdOrderIds.inbound.push(Number(seedIn._id))
  const mOutSeeded = await mat(mOutId)
  checkEq('准备库存到位（100 件）', mOutSeeded.stock, 100)

  // ================= 场景 1：同一幂等键并发提交 3 次（模拟疯狂连点）=================
  scene('场景 1 · 同一幂等键并发提交 3 次（模拟疯狂连点）')
  const before1 = await mat(mOutId)
  const cid1 = rid()
  const body1 = outboundBody(mOutId, mOut.name, 5, '防重验证：并发连点')

  const [r1a, r1b, r1c] = await Promise.all([
    call('outbound', 'submit', body1, TOKEN, cid1),
    call('outbound', 'submit', body1, TOKEN, cid1),
    call('outbound', 'submit', body1, TOKEN, cid1)
  ])
  const okCount = [r1a, r1b, r1c].filter((r) => r.code === 0).length
  const dupCount = [r1a, r1b, r1c].filter((r) => r.code === 0 && r.data && r.data.duplicated).length

  checkTrue('并发 3 次全部正常返回（没有 500 / 报错）', okCount === 3,
    `成功 ${okCount} 次，返回码 ${[r1a.code, r1b.code, r1c.code].join('/')}`)
  checkEq('数据库里该幂等键只有 1 张出库单', await countByReqId('outbound_orders', cid1), 1)
  const after1 = await mat(mOutId)
  checkEq('库存只扣了 1 次（5 件）', before1.stock - after1.stock, 5)
  checkTrue('其中 2 次被明确标记为重复提交', dupCount === 2, `重复标记 ${dupCount} 次`)

  // ================= 场景 2：同一幂等键串行重复（模拟超时后用户手点重试）=================
  scene('场景 2 · 同一幂等键串行重复提交（模拟超时后重试）')
  const before2 = await mat(mOutId)
  const cid2 = rid()
  const body2 = outboundBody(mOutId, mOut.name, 7, '防重验证：串行重试')

  const s1 = await call('outbound', 'submit', body2, TOKEN, cid2)
  const s2 = await call('outbound', 'submit', body2, TOKEN, cid2)
  const s3 = await call('outbound', 'submit', body2, TOKEN, cid2)

  checkTrue('第一次提交成功', s1.code === 0 && !s1.data.duplicated)
  checkTrue('第二次/第三次返回「已提交」而不是再下一单',
    s2.code === 0 && s2.data.duplicated === true && s3.data.duplicated === true)
  checkTrue('重试返回的是同一张单号',
    s1.data.order_no && s1.data.order_no === s2.data.order_no && s2.data.order_no === s3.data.order_no,
    `单号 ${s1.data.order_no}`)
  checkEq('数据库里该幂等键只有 1 张出库单', await countByReqId('outbound_orders', cid2), 1)
  const after2 = await mat(mOutId)
  checkEq('库存只扣了 1 次（7 件）', before2.stock - after2.stock, 7)

  // ================= 场景 3：不同幂等键的连续两笔（防误伤）=================
  scene('场景 3 · 不同幂等键连续两笔（关键：不能误伤真实下单）')
  const before3 = await mat(mOutId)
  const body3 = outboundBody(mOutId, mOut.name, 3, '防重验证：真的要下两笔')

  const t1 = await call('outbound', 'submit', body3, TOKEN, rid())
  const t2 = await call('outbound', 'submit', body3, TOKEN, rid())

  checkTrue('两笔都成功（内容相同但确是新的一笔）',
    t1.code === 0 && t2.code === 0 && !t1.data.duplicated && !t2.data.duplicated)
  checkTrue('两笔拿到不同的单号', t1.data.order_no !== t2.data.order_no,
    `${t1.data.order_no} / ${t2.data.order_no}`)
  const after3 = await mat(mOutId)
  checkEq('库存扣了 2 次（3×2＝6 件）', before3.stock - after3.stock, 6)

  // ================= 场景 4：入库同样防重，且成本只加一次 =================
  scene('场景 4 · 入库同一幂等键并发 3 次（成本不能加三遍）')
  const mInId = await newMaterial('IN' + Date.now().toString().slice(-6))
  const mIn = await mat(mInId)
  const cid4 = rid()
  const body4 = inboundBody(mInId, mIn.name, 20, 50, '防重验证：入库并发')

  const [i4a, i4b, i4c] = await Promise.all([
    call('inbound', 'submit', body4, TOKEN, cid4),
    call('inbound', 'submit', body4, TOKEN, cid4),
    call('inbound', 'submit', body4, TOKEN, cid4)
  ])
  checkTrue('并发 3 次全部正常返回',
    [i4a, i4b, i4c].every((r) => r.code === 0),
    `返回码 ${[i4a.code, i4b.code, i4c.code].join('/')}`)
  checkEq('数据库里该幂等键只有 1 张入库单', await countByReqId('inbound_orders', cid4), 1)

  const mInAfter = await mat(mInId)
  checkEq('库存只加了一次（20 件）', mInAfter.stock, 20)
  checkEq('加权成本只按一次入库算（50）', Number(mInAfter.cost.toFixed(2)), 50)

  // ================= 场景 5：供应商必填（前端可绕过，后端必须拦得住）=================
  scene('场景 5 · 采购入库供应商必填（后端兜底）')
  const noSupplier = await call('inbound', 'submit',
    inboundBody(mInId, mIn.name, 5, 10, '防重验证：不填供应商', ''), TOKEN, rid())
  checkTrue('不填供应商的采购入库被拒绝', noSupplier.code === 400, `返回 ${noSupplier.code} ${noSupplier.message || ''}`)

  const blankSupplier = await call('inbound', 'submit',
    inboundBody(mInId, mIn.name, 5, 10, '防重验证：供应商为空白', '   '), TOKEN, rid())
  checkTrue('供应商只填空格同样被拒绝', blankSupplier.code === 400, `返回 ${blankSupplier.code}`)

  const mInBefore = await mat(mInId)
  const withSupplier = await call('inbound', 'submit',
    inboundBody(mInId, mIn.name, 5, 10, '防重验证：正常带供应商'), TOKEN, rid())
  checkTrue('正常填写供应商可以入库（没有误伤）', withSupplier.code === 0, withSupplier.message)
  const mInAfter2 = await mat(mInId)
  checkEq('库存正确增加 5', mInAfter2.stock - mInBefore.stock, 5)
  if (withSupplier.code === 0 && withSupplier.data) {
    createdOrderIds.inbound.push(Number(withSupplier.data._id))
  }

  // 「入库登记」页（in/submit）是通用入口：不填供应商时前端显式传 type='other'（其他入库）。
  // 车间自制、盘盈调整这类本就没有「跟谁买的」，后端若一律按采购入库拦，这货就入不了账。
  const otherNoSupplier = await call('inbound', 'submit',
    inboundBody(mInId, mIn.name, 5, 10, '防重验证：其他入库不填供应商', '', 'other'), TOKEN, rid())
  checkTrue('其他入库不填供应商可提交（入库登记页走的路径）',
    otherNoSupplier.code === 0, otherNoSupplier.message)
  if (otherNoSupplier.code === 0 && otherNoSupplier.data) {
    createdOrderIds.inbound.push(Number(otherNoSupplier.data._id))
  }
  const mOtherAfter = await mat(mInId)
  checkEq('其他入库也正确加库存 5', mOtherAfter.stock - mInAfter2.stock, 5)
  if (i4a.code === 0 && i4a.data) createdOrderIds.inbound.push(Number(i4a.data._id))
  if (s1.code === 0 && s1.data) createdOrderIds.outbound.push(Number(s1.data._id))
  if (t1.code === 0 && t1.data) createdOrderIds.outbound.push(Number(t1.data._id))
  if (t2.code === 0 && t2.data) createdOrderIds.outbound.push(Number(t2.data._id))
  if (r1a.code === 0 && r1a.data) createdOrderIds.outbound.push(Number(r1a.data._id))

  // ================= 场景 6：流水条数与单据一一对应（不能多扣账）=================
  scene('场景 6 · 库存流水条数核对（账面不能比单据多）')
  checkEq('场景 1 那笔只产生 1 条流水', await countLogs(cid1), 1)
  checkEq('场景 4 那笔只产生 1 条流水', await countLogs(cid4), 1)
}

/* ============================================================
 * 清理
 * ============================================================ */

/**
 * 清理原则：只删「测试物料」和「测试物料关联的单据/流水」。
 * 绝不写「删掉所有没有明细的单据」这类全表兜底 —— 那会误删真实数据。
 */
async function cleanup() {
  scene('清理测试数据')

  const placeholders = (n) => Array(n).fill('?').join(',')

  // 1. 找出全部测试物料（含历史残留）
  const mats = await query('SELECT id FROM materials WHERE name LIKE ?', [`${PRE}%`])
  const matIds = mats.map((r) => Number(r.id))
  if (!matIds.length) {
    console.log('  没有测试物料，无需清理')
    return
  }
  const mp = placeholders(matIds.length)

  // 2. 这些物料牵扯到的单据
  const inOrderIds = (await query(
    `SELECT DISTINCT order_id FROM inbound_order_items WHERE material_id IN (${mp})`, matIds
  )).map((r) => Number(r.order_id))
  const outOrderIds = (await query(
    `SELECT DISTINCT order_id FROM outbound_order_items WHERE material_id IN (${mp})`, matIds
  )).map((r) => Number(r.order_id))

  for (const [table, ids] of [
    ['inbound_order_items', inOrderIds], ['outbound_order_items', outOrderIds]
  ]) {
    if (ids.length) await execute(`DELETE FROM ${table} WHERE order_id IN (${placeholders(ids.length)})`, ids)
  }
  if (inOrderIds.length) {
    await execute(`DELETE FROM inbound_orders WHERE id IN (${placeholders(inOrderIds.length)})`, inOrderIds)
  }
  if (outOrderIds.length) {
    await execute(`DELETE FROM outbound_orders WHERE id IN (${placeholders(outOrderIds.length)})`, outOrderIds)
  }

  // 3. 流水与物料本体
  await execute(`DELETE FROM stock_logs WHERE material_id IN (${mp})`, matIds)
  await execute(`DELETE FROM materials WHERE id IN (${mp})`, matIds)

  console.log(`  已清理测试物料 ${matIds.length} 条、入库单 ${inOrderIds.length} 张、出库单 ${outOrderIds.length} 张`)
  if (process.env.KEEP) console.log('  （KEEP=1 已设置，但清理仍执行了；如需保留请用 ONLY=frontend）')
}

async function guard() {
  const dirty = await queryOne(
    `SELECT COUNT(*) AS c FROM materials
      WHERE is_deleted = 0 AND name NOT LIKE ? AND (current_stock <> 0 OR avg_cost <> 0)`,
    [`${PRE}%`]
  )
  const logs = await queryOne(
    `SELECT COUNT(*) AS c FROM stock_logs l JOIN materials m ON m.id = l.material_id
      WHERE m.name NOT LIKE ?`, [`${PRE}%`]
  )
  if (Number(dirty.c) > 0 || Number(logs.c) > 0) {
    throw new Error(
      `护栏拦截：检测到真实物料被改动（库存/成本非 0 的 ${dirty.c} 条、真实流水 ${logs.c} 条）。` +
      '请先确认环境干净再跑本脚本。'
    )
  }
  console.log(`  护栏通过：真实物料库存/成本全 0，真实流水 0 条`)
}

// ---------------- 主流程 ----------------
async function main() {
  console.log('='.repeat(64))
  console.log('  专项验证：防重复提交（连点 / 超时重试）')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(64))

  // ONLY=frontend 只跑前端机制（不需要服务器）
  // ONLY=backend  只跑后端兜底
  // ONLY=e2e      只跑端到端对照
  const only = process.env.ONLY || ''
  if (only === 'frontend') {
    await runFrontendChecks()
  } else if (only === 'backend') {
    await guard(); await login(); await runBackendChecks()
  } else if (only === 'e2e') {
    await guard(); await login(); await runE2EChecks()
  } else {
    await runFrontendChecks()
    await guard()
    await login()
    await runBackendChecks()
    await runE2EChecks()
  }

  if (!process.env.KEEP && only !== 'frontend') {
    await cleanup()
  }

  const failed = results.filter((r) => r.结果 === '失败')
  console.log(`\n${'='.repeat(64)}`)
  console.log(`  通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    console.log('  失败项：')
    failed.forEach((f) => console.log(`    ✗ [${f.场景}] ${f.检查项}`))
  } else {
    console.log('  全部通过 ✓')
  }
  console.log('='.repeat(64))

  await pool.end().catch(() => {})
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error('\n执行中断：', e.message)
  await pool.end().catch(() => {})
  process.exit(2)
})
