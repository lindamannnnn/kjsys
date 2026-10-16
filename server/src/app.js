/**
 * ============================================================
 * 胜龙进销存系统 · 后端接口服务
 * ------------------------------------------------------------
 * 统一入口：POST /api/{module}
 *   body: { action, data, client_request_id }
 *   resp: { code, data, message }
 *
 * 该形态与原微信云开发完全一致，前端业务页面无需改动
 * ============================================================
 */
require('./config/env')

const express = require('express')
const cors = require('cors')
const path = require('path')

const { fail, BizError } = require('./utils/response')
const {
  verifyToken, extractToken, loadUser, hasAnyRole, identityOf
} = require('./middleware/auth')
const {
  canAccessWarehouse, requireWarehouseAccess, visibleWarehouseIds, warehouseScope
} = require('./services/warehouse')
const { auditDenied } = require('./services/audit')
const { ping } = require('./db/pool')
const {
  securityHeaders,
  checkLogin,
  noteLoginFailure,
  noteLoginSuccess
} = require('./middleware/security')

// ---------- 业务模块 ----------
const modules = [
  require('./modules/auth'),
  require('./modules/material'),
  require('./modules/outbound'),
  require('./modules/inbound'),
  require('./modules/check'),
  require('./modules/stats'),
  require('./modules/user'),
  require('./modules/supplier'),
  require('./modules/warehouse'),
  require('./modules/upload'),
  require('./modules/message'),
  require('./modules/purchase')
]

const app = express()

// ---------- 安全响应头（必须在所有路由之前） ----------
// 生产实测原先无任何安全头 → 后台公网可访问且可被 iframe 嵌套（点击劫持）
app.use(securityHeaders)

app.set('trust proxy', true)
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true, limit: '20mb' }))

// ---------- 请求日志（精简，便于排查） ----------
app.use((req, res, next) => {
  if (req.method === 'POST' || req.path === '/api/health') {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path}` +
      (body.action ? ` action=${body.action}` : '') +
      (body.client_request_id ? ` cid=${String(body.client_request_id).slice(0, 12)}` : '')
    )
  }
  next()
})

// ---------- 健康检查（GET / POST 都支持，便于各类探活工具） ----------
app.all('/api/health', async (req, res) => {
  try {
    await ping()
    res.json({
      code: 0,
      data: {
        status: 'ok',
        db: 'connected',
        time: new Date().toISOString(),
        uptime: Math.floor(process.uptime())
      },
      message: '服务正常'
    })
  } catch (e) {
    res.status(503).json({
      code: 500,
      data: { status: 'error', db: 'disconnected' },
      message: `数据库连接失败：${e.message}`
    })
  }
})

// ---------- 静态文件（替代原云存储） ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }))

// ---------- Web 后台静态托管（生产部署：admin 构建产物挂 /admin/） ----------
// 目录不存在时不启用（本地开发后台走 vite 5173，不受影响）
const ADMIN_DIR = process.env.ADMIN_DIR || path.join(__dirname, '../../admin/dist')
if (require('fs').existsSync(ADMIN_DIR)) {
  const NO_CACHE = 'no-store, no-cache, must-revalidate, max-age=0'
  // 带内容指纹（hash 文件名）的资源可以放心长缓存；
  // 但 index.html 绝不能缓存：它里面写着当前版本的 JS 文件名，
  // 一旦被浏览器缓存住，发版后用户还在用旧 index.html，引到已被删掉的旧 hash 文件，
  // 加上下面的 SPA 兜底又会把 HTML 当 JS 回给浏览器 → 页面直接白屏。
  app.use('/admin', express.static(ADMIN_DIR, {
    maxAge: '1d',
    setHeaders (res, filePath) {
      if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', NO_CACHE)
    }
  }))
  // history 模式 SPA 兜底：/admin/ 下的前端路由都回 index.html
  // 但「要的是静态资源」的请求不能兜底成 HTML —— 那样浏览器拿到 text/html 当 JS 解析，
  // 只会报一句看不懂的 MIME 错误。这里明确回 404，方便一眼看出是资源缺失。
  const ASSET_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|json|txt)$/i
  app.get('/admin/*', (req, res, next) => {
    if (ASSET_EXT.test(req.path)) return next()
    res.setHeader('Cache-Control', NO_CACHE)
    res.sendFile(path.join(ADMIN_DIR, 'index.html'))
  })
}

/**
 * 待审核账号（pending）允许调用的动作 —— 「模块名.动作名」白名单。
 *
 * 为什么需要（AUTHZ-01，2026-10-16 生产实测复现）：
 *   小程序登录是「扫码即自动建档、状态 pending、无任何角色」（见 modules/auth.js login）。
 *   而原先这里只拦 disabled，漏了 pending；那 8 个列表接口又没配 roleRules
 *   → **零角色账号可以读到**：物料档案（含 current_stock 库存、avg_cost 成本，实测 1907 条）、
 *     供应商（含 phone 联系电话）、仓库、各类单据列表。
 *   任何扫到小程序码的人都能拿到这个身份，属于实打实的数据泄露。
 *
 * 白名单只放行三类：
 *   · 登录 / 完善资料 / 看自己的信息（pending 用户要走完注册流程）
 *   · 自己的消息与待办（都按 identityOf 收敛，零角色时天然返回 0，无泄露）
 * 注意：首页的 pendingCount / pickingCount **不放行** —— 它们按仓库收敛，
 *   零角色时不过滤（实测 inbound.pendingCount 返回 2，会泄露「待确认单有几张」）；
 *   而前端那两处调用已用 safe() 包住，403 不会打断页面。
 */
const PENDING_ALLOW = new Set([
  'auth.login',
  'auth.adminLogin',
  'auth.register',
  'auth.getUserInfo',
  'auth.updateProfile',
  'auth.myLogs',
  'auth.changePassword',
  'message.list',
  'message.unreadCount',
  'message.markRead',
  'message.markAllRead',
  'outbound.myNotice',
  'purchase.myTodoCount'
])

/**
 * 需要做「暴力破解防护」的动作。
 *
 * 为什么只覆盖 adminLogin（2026-10-16 生产隐患排查）：
 *   后台是公网可访问的，adminLogin 原先**没有任何失败计数** —— 密码可以被无限次猜。
 *   小程序 login 走微信 code（一次性、不可枚举），changePassword 需要已登录的令牌，
 *   都不构成匿名猜解面，因此不纳入（纳入了反而可能把正常用户锁在外面）。
 */
const LOGIN_GUARDED = new Set(['auth.adminLogin'])

// ---------- 业务模块统一分发 ----------
for (const mod of modules) {
  app.post(`/api/${mod.name}`, async (req, res) => {
    const body = req.body || {}
    const { action, data = {}, client_request_id } = body
    // ctx 必须在 try 外声明：catch 里的越权留痕（auditDenied）也要用它，
    // 否则 BizError 401/403 一进 catch 就 ReferenceError 把整个进程搞挂（V4 测试 P0）
    let ctx = null

    try {
      if (!action) {
        return res.json(fail(400, '缺少 action 参数'))
      }

      const handler = mod.actions && mod.actions[action]
      if (typeof handler !== 'function') {
        return res.json(fail(404, `未知操作：${mod.name}.${action}`))
      }

      const isPublic = (mod.publicActions || []).includes(action)

      // ---- 构造上下文 ----
      ctx = {
        module: mod.name,
        action,
        clientRequestId: client_request_id || '',
        ip: req.ip || '',
        user: null,
        jwt: null,
        // 仓库级数据权限（整改 P0-3.1：原先定义了却零调用，现统一挂到 ctx）
        canAccessWarehouse: (wid) => canAccessWarehouse(ctx.user, wid),
        requireWarehouseAccess: (wid, label) => requireWarehouseAccess(ctx.user, wid, label),
        visibleWarehouseIds: () => visibleWarehouseIds(ctx.user),
        warehouseScope: (alias, requested) => warehouseScope(ctx.user, alias, requested)
      }

      // ---- 尝试解析令牌 ----
      const token = extractToken(req)
      if (token) {
        const payload = verifyToken(token)
        if (payload) {
          const user = await loadUser(payload)
          if (user) {
            ctx.user = user
            ctx.jwt = payload
          }
        }
      }

      // ---- 登录校验 ----
      if (!isPublic) {
        if (!ctx.user) {
          // 提示语区分「压根没登录」和「登录态过期」：
          // 原来一律说"登录已过期，请重新登录"，从没登录过的人看了莫名其妙
          // （来自 4 角色使用者测试 P2-未登录提示）。
          const msg = token ? '登录已过期，请重新登录' : '请先登录'
          // 留痕：伪造 token / 过期 token 反复打接口是异常信号，必须能事后发现
          auditDenied({ ctx, moduleName: mod.name, action, code: 401, reason: msg })
          return res.json(fail(401, msg))
        }
        if (ctx.user.status === 'disabled') {
          auditDenied({ ctx, moduleName: mod.name, action, code: 403, reason: '账号已被禁用' })
          return res.json(fail(403, '账号已被禁用，请联系管理员'))
        }
        // ---- 待审核账号拦截（AUTHZ-01）----
        // 原先只拦 disabled、漏了 pending → 零角色账号能读物料/供应商/仓库/单据列表（生产实测）。
        // 审核通过前只放行「登录 / 完善资料 / 看自己」，其余一律 403。
        if (ctx.user.status === 'pending' && !PENDING_ALLOW.has(`${mod.name}.${action}`)) {
          auditDenied({ ctx, moduleName: mod.name, action, code: 403, reason: '账号待审核' })
          return res.json(fail(403, '账号正在审核中，请等待管理员审核通过'))
        }
      }

      // ---- 角色权限校验 ----
      const needRoles = mod.roleRules && mod.roleRules[action]
      if (needRoles && !hasAnyRole(ctx.user, needRoles)) {
        // 「有人在试越权」是安全事件的第一手线索，必须留痕（V3 测试 P1-8）
        auditDenied({
          ctx, moduleName: mod.name, action, code: 403,
          reason: `角色不足（该操作需要：${needRoles.join('/')}）`
        })
        return res.json(fail(403, '无操作权限'))
      }

      // ---- 强制改密门禁（整改 P0-2-02：初始密码 admin123456 可直接登录超管） ----
      // 允许放行的动作：改密本身、查自己信息、登出式的查询
      const PASSWORD_EXEMPT = ['changePassword', 'getUserInfo', 'myLogs']
      if (
        ctx.user &&
        Number(ctx.user.must_change_password) === 1 &&
        !isPublic &&
        !PASSWORD_EXEMPT.includes(action)
      ) {
        return res.json(fail(403, '首次登录必须先修改初始密码，请前往「修改密码」'))
      }

      // ---- 登录暴力破解防护（只拦，不阻断正常用户）----
      const guarded = LOGIN_GUARDED.has(`${mod.name}.${action}`)
      if (guarded) {
        const g = checkLogin(action, req, data)
        if (g.blocked) {
          auditDenied({
            ctx, moduleName: mod.name, action, code: 429,
            reason: `登录尝试过多：${g.message}`
          })
          res.setHeader('Retry-After', String(g.retryAfter))
          return res.json(fail(429, g.message))
        }
      }

      // ---- 执行 ----
      const result = await handler(ctx, data)

      // 只把「失败」计入限流：正常用户输错一两次不受影响，
      // 成功登录还会把该账号的失败记录清掉，避免误伤。
      if (guarded) {
        if (result && typeof result === 'object' && result.code === 0) {
          noteLoginSuccess(action, req, data)
        } else {
          noteLoginFailure(action, req, data)
        }
      }

      // handler 统一返回 { code, data, message }
      if (result && typeof result === 'object' && 'code' in result) {
        // 业务层自己判出来的 401/403 同样要留痕
        // （例如「只有管理员才能授予管理员」「无权操作该仓库」这类）
        if (result.code === 401 || result.code === 403) {
          auditDenied({
            ctx, moduleName: mod.name, action, code: result.code,
            reason: result.message
          })
        }
        return res.json(result)
      }
      // 容错：handler 直接返回数据时自动包装
      return res.json({ code: 0, data: result === undefined ? null : result, message: '操作成功' })
    } catch (err) {
      if (err instanceof BizError) {
        // 抛出来的 403（如 ctx.requireWarehouseAccess 跨仓拦截）也要留痕
        if (err.code === 401 || err.code === 403) {
          auditDenied({ ctx: ctx || {}, moduleName: mod.name, action, code: err.code, reason: err.message })
        }
        return res.json(fail(err.code, err.message))
      }

      // 数据库原始报错不对外暴露（整改 P1-6：会把
      // "Duplicate entry 'CHK-...' for key 'stock_checks.uk_check_no'" 直接甩给使用者）
      const dbCode = err && err.code ? String(err.code) : ''
      if (dbCode === 'ER_DUP_ENTRY') {
        console.error(`[错误] ${mod.name}.${action} 唯一键冲突`, err.message)
        return res.json(fail(409, '操作发生冲突（可能有人同时在处理同一笔数据），请刷新后重试'))
      }
      if (dbCode.startsWith('ER_')) {
        console.error(`[错误] ${mod.name}.${action} 数据库异常`, err)
        return res.json(fail(500, '服务暂时无法处理该请求，系统已记录该错误，请联系管理员'))
      }

      console.error(`[错误] ${mod.name}.${action}`, err)
      return res.json(fail(500, err.message || '服务端错误'))
    }
  })
}

// ---------- 未匹配路由 ----------
app.use((req, res) => {
  res.status(404).json(fail(404, `接口不存在：${req.method} ${req.path}`))
})

// ---------- 全局错误兜底 ----------
app.use((err, req, res, next) => {
  console.error('[全局错误]', err)
  // 同样不把原始异常信息（含 SQL 报错）返回给使用者
  res.status(500).json(fail(500, '服务暂时无法处理该请求，系统已记录该错误，请联系管理员'))
})

// ---------- 启动 ----------
const PORT = Number(process.env.PORT || 3000)
// 监听地址：默认 0.0.0.0（本地开发真机联调要局域网可达）。
// ⚠️ 生产建议显式设 HOST=127.0.0.1 —— 对外只走 Nginx 反代（HTTPS），
//    否则公网可用明文 HTTP 直连 3000，绕过 TLS。
const HOST = process.env.HOST || '0.0.0.0'

async function bootstrap() {
  try {
    await ping()
    console.log('[数据库] 连接成功')
  } catch (e) {
    console.error('[数据库] 连接失败：', e.message)
    console.error('请确认 MySQL 已启动，且 .env 中的 DB_* 配置正确')
  }

  app.listen(PORT, HOST, () => {
    console.log('==============================================')
    console.log('  胜龙进销存系统 · 后端接口服务已启动')
    console.log(`  监听: ${HOST}:${PORT}${HOST === '127.0.0.1' ? '（仅本机，外网走 Nginx 反代）' : ''}`)
    console.log(`  健康检查: http://127.0.0.1:${PORT}/api/health`)
    console.log(`  模块: ${modules.map((m) => m.name).join(', ')}`)
    console.log('==============================================')
  })

  // 定时任务（库存预警、每日备份）
  try {
    require('./jobs').start()
  } catch (e) {
    console.warn('[定时任务] 启动失败（不影响接口服务）：', e.message)
  }
}

if (require.main === module) {
  bootstrap()
}

module.exports = app
