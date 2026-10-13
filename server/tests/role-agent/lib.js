/**
 * 岗位 Agent 测试框架 · 公共库
 * ============================================================
 * 提供：
 *   - callRaw()       与服务端同信封的 HTTP 调用（{action, data, client_request_id}）
 *   - loginDev()      模拟微信身份登录（dev_openid 直通，需 ALLOW_DEV_LOGIN=true）
 *   - loginAdmin()    后台账号密码登录
 *   - RoleAgent       岗位 Agent 基类：断言、记录、问题分级（P0/P1/P2）
 *
 * 问题分级：
 *   P0 权限门被穿透 / 资损（金额、库存被改错）/ 死锁
 *   P1 功能错误 / 数据不一致（后台看板 vs 小程序 vs 数据库）
 *   P2 体验、文案、提示语
 * ============================================================
 */
require('../../src/config/env')

const http = require('http')
const { query, queryOne, execute } = require('../../src/db/pool')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'

/** 流程中断错误：一个关键步骤失败时，抛出它让本角色本轮剩余步骤跳过（已记录 P1） */
class FlowAbort extends Error {}

/** 统一请求封装 */
function callRaw(mod, action, data = {}, token = '', clientRequestId = '') {
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

    const req = http.request(`${BASE}/api/${mod}`, { method: 'POST', headers, timeout: 20000 }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch { reject(new Error(`响应非 JSON：${raw.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(payload)
    req.end()
  })
}

/** 模拟微信身份登录 → token */
async function loginDev(openid) {
  const res = await callRaw('auth', 'login', { dev_openid: openid })
  if (!res || res.code !== 0) throw new Error(`dev 登录失败（${openid}）：${res && res.message}`)
  return res.data.token
}

/** 后台账号密码登录 → token */
async function loginAdmin(username, password) {
  const res = await callRaw('auth', 'adminLogin', { username, password })
  if (!res || res.code !== 0) {
    const err = new Error(`后台登录失败（${username}）：${res && res.message}`)
    err.code = res && res.code
    throw err
  }
  return res.data.token
}

/** 数字安全转换 */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 两位小数比较 */
function moneyEq(a, b) {
  return Math.abs(num(a) - num(b)) < 0.005
}

class RoleAgent {
  /**
   * @param {object} o { role, name, token, round, mark, results }
   * results: 共享数组，每条 { round, role, label, pass, level, detail }
   */
  constructor(o) {
    this.role = o.role
    this.name = o.name
    this.token = o.token
    this.round = o.round
    this.mark = o.mark
    this.results = o.results
  }

  /** 调接口 */
  call(mod, action, data = {}, cri = '') {
    return callRaw(mod, action, data, this.token, cri)
  }

  /**
   * 断言：cond 为真记通过，为假记问题
   * @returns {boolean} 断言结果
   */
  check(label, cond, level = 'P1', detail = '') {
    this.results.push({
      round: this.round, role: this.role, label,
      pass: !!cond, level: cond ? '' : level, detail: String(detail || '')
    })
    return !!cond
  }

  /**
   * 期望成功：失败则记录 level 级问题并抛 FlowAbort（该角色本轮后续步骤跳过）
   * @returns {any} res.data
   */
  mustOk(label, res, level = 'P1') {
    const okRes = res && res.code === 0
    this.check(label, okRes, level, okRes ? '' : `code=${res && res.code} ${res && res.message}`)
    if (!okRes) throw new FlowAbort(label)
    return res.data
  }

  /**
   * 期望被拒：code 必须等于期望值（默认非 0 即可，传 exactCode 精确匹配）
   */
  expectFail(label, res, level = 'P0', exactCode = 0, note = '') {
    const code = res && res.code
    const pass = exactCode ? code === exactCode : code !== 0
    this.check(
      label, pass, level,
      pass ? '' : `期望被拒(${exactCode || '非0'})，实际 code=${code} ${res && res.message} ${note}`
    )
    return pass
  }
}

module.exports = {
  BASE, callRaw, loginDev, loginAdmin, RoleAgent, FlowAbort, num, moneyEq,
  db: { query, queryOne, execute }
}
