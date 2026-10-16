/**
 * 安全中间件：响应安全头 + 登录限流
 *
 * 为什么需要（2026-10-16 生产隐患排查发现）：
 *   1) 生产**没有任何安全响应头**（实测 /api/health 无 X-Frame-Options 等）。
 *      后台是公网可访问的，缺 X-Frame-Options 意味着可被 iframe 嵌套做点击劫持。
 *   2) **登录接口零限流**：adminLogin 无论失败多少次都照常返回「账号或密码错误」，
 *      密码可被无限次暴力猜解。后台公网开放 + 7 天长效令牌，这一步是必须的。
 *
 * 限流为什么分两层：
 *   只按 IP 限流不可靠 —— nginx 若用 $proxy_add_x_forwarded_for 会把客户端自带的
 *   X-Forwarded-For 原样保留在最左侧，而 Express 的 trust proxy 取最左值，
 *   攻击者只要每次换个伪造 XFF 就能绕开 IP 限流。
 *   因此**按账号**限流是主防线（不可伪造），按 IP 只是辅助（挡住同一来源的批量试探）。
 */

// ==================== 一、安全响应头 ====================

/**
 * 统一注入安全响应头。
 * 说明：
 *   · X-Content-Type-Options: nosniff  —— 阻止浏览器把 .txt 当脚本执行
 *   · X-Frame-Options: DENY            —— 禁止被 iframe 嵌套（防点击劫持）
 *   · Referrer-Policy                  —— 跨站时不泄漏后台地址
 *   · HSTS                             —— 仅在 HTTPS 请求上发（探测端口是 HTTP，发了也无害但无意义）
 *   · 移除 X-Powered-By                —— 不对外暴露技术栈
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  // 小程序 / 后台前端都在同域或白名单内，这里不设 CSP 以免打断 admin 静态资源；
  // 但至少禁止把本页作为 object/embed 嵌入。
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }
  res.removeHeader('X-Powered-By')
  next()
}

// ==================== 二、登录限流 ====================

/** 统计窗口：10 分钟 */
const WINDOW_MS = 10 * 60 * 1000
/** 同一账号允许的失败次数（主防线，不可伪造） */
const MAX_PER_ACCOUNT = 8
/** 同一来源 IP 允许的失败次数（辅助防线） */
const MAX_PER_IP = 30

/** key -> 失败时间戳数组 */
const buckets = new Map()

/** 清理过期时间戳，返回窗口内的那些 */
function alive(key) {
  const now = Date.now()
  const arr = (buckets.get(key) || []).filter((t) => now - t < WINDOW_MS)
  if (arr.length) buckets.set(key, arr)
  else buckets.delete(key)
  return arr
}

/** 该 key 是否已被限流；是则返回剩余等待秒数，否则返回 0 */
function blockedFor(key, max) {
  const arr = alive(key)
  if (arr.length < max) return 0
  const oldest = arr[0]
  return Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - oldest)) / 1000))
}

/** 记一次失败 */
function recordFailure(keys) {
  const now = Date.now()
  for (const k of keys) {
    const arr = alive(k)
    arr.push(now)
    buckets.set(k, arr)
  }
}

/** 登录成功后清掉该账号的失败记录（避免误伤正常用户） */
function clearFailures(keys) {
  for (const k of keys) buckets.delete(k)
}

/** 归一化 IP（IPv6 映射地址 ::ffff:1.2.3.4 → 1.2.3.4） */
function normalizeIp(ip) {
  if (!ip) return 'unknown'
  return String(ip).replace(/^::ffff:/, '')
}

/**
 * 登录动作的限流键。
 * @param {string} action  动作名（login / adminLogin）
 * @param {object} req
 * @param {object} data    请求体里的 data
 */
function loginKeys(action, req, data = {}) {
  const ip = normalizeIp(req.ip || (req.socket && req.socket.remoteAddress))
  const account = String(data.username || data.account || data.phone || '').trim().toLowerCase()
  let keys = [`ip:${action}:${ip}`]
  if (account) keys.push(`acct:${action}:${account}`)
  return { keys, ip, account }
}

/**
 * 检查是否应拦截本次登录尝试。
 * 返回 { blocked: bool, message, retryAfter } —— blocked 为 true 时应直接返回 429。
 */
function checkLogin(action, req, data) {
  const { keys, account } = loginKeys(action, req, data)
  const acctKey = keys.find((k) => k.startsWith('acct:'))
  const ipKey = keys.find((k) => k.startsWith('ip:'))

  if (acctKey) {
    const wait = blockedFor(acctKey, MAX_PER_ACCOUNT)
    if (wait) {
      return {
        blocked: true,
        retryAfter: wait,
        message: `该账号密码错误次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`
      }
    }
  }
  const waitIp = blockedFor(ipKey, MAX_PER_IP)
  if (waitIp) {
    return {
      blocked: true,
      retryAfter: waitIp,
      message: `当前网络登录尝试过于频繁，请 ${Math.ceil(waitIp / 60)} 分钟后再试`
    }
  }
  return { blocked: false, keys, account }
}

/** 记一次登录失败 */
function noteLoginFailure(action, req, data) {
  const { keys } = loginKeys(action, req, data)
  recordFailure(keys)
}

/** 登录成功后清除失败计数 */
function noteLoginSuccess(action, req, data) {
  const { keys } = loginKeys(action, req, data)
  clearFailures(keys)
}

/** 供测试/排查使用的内部状态 */
function _stats() {
  return { buckets: buckets.size, windowMs: WINDOW_MS, maxPerAccount: MAX_PER_ACCOUNT, maxPerIp: MAX_PER_IP }
}

/** 定期清理空桶，避免长期运行内存缓慢增长（unref 不阻塞进程退出） */
const sweeper = setInterval(() => {
  for (const k of [...buckets.keys()]) alive(k)
}, 5 * 60 * 1000)
if (sweeper.unref) sweeper.unref()

module.exports = {
  securityHeaders,
  checkLogin,
  noteLoginFailure,
  noteLoginSuccess,
  blockedFor,
  recordFailure,
  clearFailures,
  _stats
}
