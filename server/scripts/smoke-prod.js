#!/usr/bin/env node
'use strict'
/**
 * 真实接口冒烟（打真实服务）
 * ============================================================
 * 为什么必须打真实环境：
 *   本地库与生产库不是同一份（2026-10-16 的 P0 就是「生产库落后于代码」）。
 *   本地全绿 ≠ 生产能跑。所以上线前要拿真实服务验一遍。
 *
 * 污染控制（重要，踩过坑）：
 *   ① 只读接口：正常调用，期望 code=0
 *      ⚠️ 但**不能拿写死的 id**（id=1 在真实库里往往不存在）→ 先用 list 探到真实样本 id 再查。
 *   ② 写接口：**只传缺参 / 不存在的 id**，期望 400/403/404。
 *      正确行为是「明确告诉你缺什么」；返回 500 说明未捕获异常，是缺陷。
 *   ③ ⚠️ 有**副作用**的接口不能放进守卫清单：例如 message.markAllRead
 *      —— 它没有必填参数，传空对象也会「成功」，等于把消息真标成已读。
 *      这类必须排除，否则脚本一边"零污染"一边改数据（实测踩到）。
 *   真实业务链路的写操作另见 prod-chain（带测试标记 + 自清理，需人工确认后跑）。
 *
 * 用法：
 *   SMOKE_TOKEN=<token> node scripts/smoke-prod.js
 *   SMOKE_USER=admin SMOKE_PASS=*** node scripts/smoke-prod.js
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 SMOKE_TOKEN=*** node scripts/smoke-prod.js
 *
 * 退出码：0=只读全通且无 500；1=有真缺陷；2=脚本自身失败
 * ============================================================
 */
const fs = require('fs')
const path = require('path')

const BASE = (process.env.SMOKE_BASE_URL || 'https://sl.ekkosys.cn').replace(/\/+$/, '')
const TOKEN = (process.env.SMOKE_TOKEN || '').trim()
const USER = process.env.SMOKE_USER || ''
const PASS = process.env.SMOKE_PASS || ''
const OUT_DIR = path.join(__dirname, 'out')

const url = new URL(BASE)
const lib = url.protocol === 'https:' ? require('https') : require('http')

let _seq = 0

/**
 * ⚠️ 请求体结构（踩过坑）：参数必须包在 data 里
 *   { action, data: {...}, client_request_id }
 *   平铺传参 → 后端读到空 → 报「请输入账号和密码」这类"缺参"，极易误判成接口坏了。
 */
function post(mod, action, payload, token) {
  return new Promise((resolve) => {
    const body = {
      action,
      data: payload || {},
      client_request_id: `smoke-${Date.now()}-${++_seq}`
    }
    const data = Buffer.from(JSON.stringify(body))
    const req = lib.request(
      {
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `/api/${mod}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        timeout: 25000
      },
      (res) => {
        let b = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          let j = {}
          try {
            j = JSON.parse(b)
          } catch (e) {
            j = { code: -2, message: '响应非 JSON: ' + b.slice(0, 120) }
          }
          resolve({ http: res.statusCode, code: j.code, message: j.message, data: j.data })
        })
      }
    )
    req.on('error', (e) => resolve({ http: 0, code: -1, message: '网络错误 ' + e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ http: 0, code: -1, message: '超时(25s)' })
    })
    req.write(data)
    req.end()
  })
}

/** 只读接口：期望 code=0。param 可为对象，或 (ids) => 对象（依赖探到的真实 id） */
const READ = [
  ['auth', 'getUserInfo', {}],
  ['auth', 'myLogs', {}],
  ['material', 'list', { page: 1, pageSize: 5 }],
  ['material', 'categories', {}],
  ['material', 'detail', (ids) => ({ id: ids.material })],
  ['check', 'list', { page: 1, pageSize: 5 }],
  ['check', 'detail', (ids) => ({ id: ids.check })],
  ['inbound', 'list', { page: 1, pageSize: 5 }],
  ['inbound', 'detail', (ids) => ({ id: ids.inbound })],
  ['inbound', 'pendingCount', {}],
  ['message', 'list', { page: 1, pageSize: 5 }],
  ['message', 'unreadCount', {}],
  ['outbound', 'list', { page: 1, pageSize: 5 }],
  ['outbound', 'detail', (ids) => ({ id: ids.outbound })],
  ['outbound', 'pendingCount', {}],
  ['outbound', 'pickingCount', {}],
  ['outbound', 'myNotice', {}],
  ['purchase', 'list', { page: 1, pageSize: 5 }],
  ['purchase', 'detail', (ids) => ({ id: ids.purchase })],
  ['purchase', 'myTodoCount', {}],
  ['purchase', 'assignees', {}],
  ['stats', 'overview', {}],
  ['stats', 'trend', {}],
  ['stats', 'stockList', { page: 1, pageSize: 5 }],
  ['stats', 'orderFlow', { page: 1, pageSize: 5 }],
  ['stats', 'warning', {}],
  ['stats', 'stockFlow', { page: 1, pageSize: 5 }],
  ['stats', 'materialRank', {}],
  ['stats', 'operatorStats', {}],
  ['stats', 'warehouseSummary', {}],
  ['stats', 'monthly', (ids) => ({ warehouse_id: ids.warehouse })],
  ['supplier', 'list', { page: 1, pageSize: 5 }],
  ['supplier', 'search', { keyword: 'a' }],
  ['user', 'list', { page: 1, pageSize: 5 }],
  ['user', 'detail', (ids) => ({ id: ids.user })],
  ['user', 'pendingCount', {}],
  ['user', 'logs', { page: 1, pageSize: 5 }],
  ['user', 'assignees', {}],
  ['warehouse', 'list', {}]
]

/**
 * 入参守卫：写接口传「缺参 / 不存在的 id」，正确行为是 code=400/403/404（明确告知），
 * 若返回 500 = 未捕获异常（真缺陷）。
 * ⚠️ 只能放「必填参数缺失就会报错」的接口。
 *    像 message.markAllRead 这种没有必填参数、传空也照做的，**绝不能放这里**（会真改数据）。
 */
const GUARD = [
  ['material', 'upsert', {}],
  ['supplier', 'upsert', {}],
  ['inbound', 'submit', {}],
  ['inbound', 'confirm', {}],
  ['inbound', 'cancel', {}],
  ['inbound', 'updatePrice', {}],
  ['outbound', 'submit', {}],
  ['outbound', 'confirm', {}],
  ['outbound', 'pickDone', {}],
  ['outbound', 'receive', {}],
  ['outbound', 'reject', {}],
  ['outbound', 'cancel', {}],
  ['check', 'create', {}],
  ['check', 'submit', {}],
  ['check', 'review', {}],
  ['check', 'cancel', {}],
  ['purchase', 'create', {}],
  ['purchase', 'take', {}],
  ['purchase', 'entry', {}],
  ['purchase', 'receive', {}],
  ['purchase', 'rejectBack', {}],
  ['purchase', 'cancel', {}],
  ['purchase', 'stockItem', {}],
  ['message', 'markRead', {}],
  ['user', 'approve', {}],
  ['user', 'updateRole', {}],
  ['user', 'create', {}],
  ['user', 'resetPassword', {}],
  ['warehouse', 'upsert', {}],
  ['upload', 'upload', {}],
  ['upload', 'delete', {}],
  // 不存在的 id：应当明确回 404，而不是 500
  ['material', 'detail', { id: 99999999 }],
  ['supplier', 'detail', { id: 99999999 }],
  ['material', 'delete', { id: 99999999 }],
  ['supplier', 'delete', { id: 99999999 }]
]

const OK_GUARD = [400, 403, 404]

/** 取列表首条的 _id，用于给 detail 类接口准备真实样本 */
function firstId(r) {
  const d = r && r.data
  const list = d && (Array.isArray(d) ? d : d.list)
  if (Array.isArray(list) && list.length) return list[0]._id
  return undefined
}

/** 探测真实样本 id（真实库里 id 不一定从 1 开始，写死 id=1 会假失败） */
async function probeIds(token) {
  const ids = {}
  ids.material = firstId(await post('material', 'list', { page: 1, pageSize: 1 }, token))
  ids.check = firstId(await post('check', 'list', { page: 1, pageSize: 1 }, token))
  ids.inbound = firstId(await post('inbound', 'list', { page: 1, pageSize: 1 }, token))
  ids.outbound = firstId(await post('outbound', 'list', { page: 1, pageSize: 1 }, token))
  ids.purchase = firstId(await post('purchase', 'list', { page: 1, pageSize: 1 }, token))
  ids.user = firstId(await post('user', 'list', { page: 1, pageSize: 1 }, token))
  ids.warehouse = firstId(await post('warehouse', 'list', {}, token))
  return ids
}

async function main() {
  const results = { at: new Date().toISOString(), base: BASE, login: null, ids: null, read: [], guard: [], summary: {} }

  console.log('==================================================')
  console.log('  真实接口冒烟')
  console.log(`  目标：${BASE}`)
  console.log('==================================================\n')

  // ---------- 身份 ----------
  let token = TOKEN
  if (!token) {
    if (!USER || !PASS) {
      console.error('❌ 缺少凭据：请设置 SMOKE_TOKEN（推荐）或 SMOKE_USER + SMOKE_PASS')
      process.exit(2)
    }
    const lg = await post('auth', 'adminLogin', { username: USER, password: PASS })
    if (lg.code !== 0 || !lg.data || !lg.data.token) {
      console.error('❌ 登录失败：', lg.code, lg.message)
      process.exit(2)
    }
    token = lg.data.token
  }

  const me = await post('auth', 'getUserInfo', {}, token)
  if (me.code !== 0) {
    console.error('❌ 取用户信息失败（令牌可能已过期）：', me.code, me.message)
    process.exit(2)
  }
  const u = me.data || {}
  results.login = { user: u.real_name || u.username, roles: u.roles, status: u.status }
  console.log(`✅ 身份：${u.real_name || u.username}（${u.username}）  角色=${JSON.stringify(u.roles)}  状态=${u.status}`)
  console.log(`   仓库=${JSON.stringify(u.warehouse_ids)}\n`)

  // ---------- 探测样本 id ----------
  const ids = await probeIds(token)
  results.ids = ids
  console.log(`🔎 真实样本 id：${JSON.stringify(ids)}\n`)

  // ---------- 一、只读接口 ----------
  console.log('========== 一、只读接口（期望 code=0）==========')
  for (const [mod, act, param] of READ) {
    const p = typeof param === 'function' ? param(ids) : param
    // 依赖样本 id 但库里没有样本 → 跳过（不算缺陷，但要让人知道没测到）
    if (p && Object.values(p).some((v) => v === undefined || v === null)) {
      results.read.push({ api: `${mod}.${act}`, ok: true, skipped: true, message: '库里无样本，未测' })
      console.log(`⏭️  ${mod}.${act}  跳过（库里没有可用的样本数据）`)
      continue
    }
    const r = await post(mod, act, p, token)
    const ok = r.code === 0
    results.read.push({ api: `${mod}.${act}`, ok, http: r.http, code: r.code, message: r.message })
    console.log(`${ok ? '✅' : '❌'} ${mod}.${act}  code=${r.code}  ${ok ? '' : r.message || ''}`)
  }

  // ---------- 二、入参守卫 ----------
  console.log('\n========== 二、写接口入参守卫（期望 400/403/404；500 即缺陷）==========')
  for (const [mod, act, param] of GUARD) {
    const r = await post(mod, act, param, token)
    const ok = OK_GUARD.includes(r.code)
    results.guard.push({ api: `${mod}.${act}`, ok, code: r.code, message: r.message })
    console.log(`${ok ? '✅' : r.code === 500 ? '🔥' : '⚠️'} ${mod}.${act}  code=${r.code}  ${r.message || ''}`)
  }

  // ---------- 汇总 ----------
  const readFail = results.read.filter((x) => !x.ok)
  const readSkip = results.read.filter((x) => x.skipped)
  const guard500 = results.guard.filter((x) => x.code === 500)
  const guardOdd = results.guard.filter((x) => !x.ok && x.code !== 500)
  results.summary = {
    readTotal: results.read.length,
    readFail: readFail.length,
    readSkip: readSkip.length,
    guardTotal: results.guard.length,
    guard500: guard500.length,
    guardOdd: guardOdd.length
  }

  console.log('\n================ 汇总 ================')
  console.log(
    `只读接口 ${results.read.length} 个：通过 ${results.read.length - readFail.length - readSkip.length}，跳过 ${readSkip.length}，失败 ${readFail.length}`
  )
  console.log(
    `入参守卫 ${results.guard.length} 个：规范 ${results.guard.length - guard500.length - guardOdd.length}，未捕获异常(500) ${guard500.length}，其他异常码 ${guardOdd.length}`
  )
  if (readFail.length) {
    console.log('\n只读失败清单：')
    readFail.forEach((f) => console.log(`  · ${f.api}  code=${f.code}  ${f.message}`))
  }
  if (guard500.length) {
    console.log('\n🔥 500 崩溃清单：')
    guard500.forEach((f) => console.log(`  · ${f.api}  ${f.message}`))
  }

  // ---------- 落盘 ----------
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
  console.log(`\n结果已落盘：${outFile}`)

  const bad = readFail.length + guard500.length
  console.log(bad ? `\n❌ 共 ${bad} 项缺陷` : '\n✅ 只读全通、无 500')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error('冒烟脚本自身异常：', e)
  process.exit(2)
})
