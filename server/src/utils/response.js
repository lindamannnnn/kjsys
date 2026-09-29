/**
 * 统一响应格式（与云开发版完全一致，保证前端无需改动）
 *   { code: 0, data: {...}, message: '...' }
 * code: 0 成功 / 400 参数错误 / 401 未登录 / 403 无权限 / 404 不存在 / 409 冲突 / 500 服务端错误
 */

function ok(data = null, message = '操作成功') {
  return { code: 0, data, message }
}

function fail(code = 500, message = '操作失败') {
  return { code, data: null, message }
}

/** 业务异常：抛出后由 app.js 统一捕获并转成 fail() */
class BizError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BizError'
    this.code = code
  }
}

/** 常用错误快捷方法（在业务代码中直接 throw） */
const errors = {
  badRequest: (msg = '参数错误') => new BizError(400, msg),
  unauthorized: (msg = '登录已过期，请重新登录') => new BizError(401, msg),
  forbidden: (msg = '无操作权限') => new BizError(403, msg),
  notFound: (msg = '数据不存在') => new BizError(404, msg),
  conflict: (msg = '数据冲突') => new BizError(409, msg),
  server: (msg = '服务端错误') => new BizError(500, msg),
  biz: (msg = '操作失败') => new BizError(400, msg)
}

module.exports = { ok, fail, BizError, errors }
