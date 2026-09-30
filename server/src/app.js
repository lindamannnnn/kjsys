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
const { ping } = require('./db/pool')

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
  require('./modules/upload')
]

const app = express()

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
  app.use('/admin', express.static(ADMIN_DIR, { maxAge: '1d' }))
  // history 模式 SPA 兜底：/admin/ 下的前端路由都回 index.html
  app.get('/admin/*', (req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')))
}

// ---------- 业务模块统一分发 ----------
for (const mod of modules) {
  app.post(`/api/${mod.name}`, async (req, res) => {
    const body = req.body || {}
    const { action, data = {}, client_request_id } = body

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
      const ctx = {
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
          return res.json(
            token
              ? fail(401, '登录已过期，请重新登录')
              : fail(401, '请先登录')
          )
        }
        if (ctx.user.status === 'disabled') {
          return res.json(fail(403, '账号已被禁用，请联系管理员'))
        }
      }

      // ---- 角色权限校验 ----
      const needRoles = mod.roleRules && mod.roleRules[action]
      if (needRoles && !hasAnyRole(ctx.user, needRoles)) {
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

      // ---- 执行 ----
      const result = await handler(ctx, data)

      // handler 统一返回 { code, data, message }
      if (result && typeof result === 'object' && 'code' in result) {
        return res.json(result)
      }
      // 容错：handler 直接返回数据时自动包装
      return res.json({ code: 0, data: result === undefined ? null : result, message: '操作成功' })
    } catch (err) {
      if (err instanceof BizError) {
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

async function bootstrap() {
  try {
    await ping()
    console.log('[数据库] 连接成功')
  } catch (e) {
    console.error('[数据库] 连接失败：', e.message)
    console.error('请确认 MySQL 已启动，且 .env 中的 DB_* 配置正确')
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('==============================================')
    console.log('  胜龙进销存系统 · 后端接口服务已启动')
    console.log(`  地址: http://0.0.0.0:${PORT}`)
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
