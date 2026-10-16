/**
 * 站内消息模块（流程重构 V2 · P1 消息中心）
 * ------------------------------------------------------------
 * 权限模型：不设 roleRules —— 任何登录用户都应该能查自己的消息；
 * 但所有读写都强制带上「自己的收件人键」，
 * 因此不存在「查/改别人的消息」的入口。
 */
const { query, queryOne, execute } = require('../db/pool')
const { ok, fail } = require('../utils/response')
const { toApi, paging, num } = require('../utils/format')
const { identityOf } = require('../middleware/auth')

/**
 * 当前登录人的「收件人键」= openid 优先，没有 openid 则回落到 username。
 * ⚠️ 必须与发消息端同一口径（services/message.js 的 WHO_SQL / middleware/auth.js 的 identityOf）。
 *   这里是「读」的一侧。历史缺陷（2026-10-16 生产盘查发现）：原来只用 openid，
 *   而发消息端早已改成 COALESCE(openid, username) → 后台手工建的账号（无 openid，
 *   生产上多数如此）消息列表永远为空、unreadCount 恒为 0、markRead/markAllRead 直接
 *   401「请先登录」，可消息其实已经按 username 写进库了 —— 属于静默失效，最难被发现。
 */
function myKey(ctx) {
  return identityOf(ctx.user)
}

/** 消息列表：默认全部，可只看未读 */
async function list(ctx, data = {}) {
  const who = myKey(ctx)
  if (!who) return ok({ list: [], total: 0, unread: 0, page: 1, pageSize: 20 })

  const onlyUnread =
    data.only_unread === true ||
    data.only_unread === 1 ||
    data.only_unread === '1' ||
    data.only_unread === 'true'

  const { page, pageSize, offset } = paging(data)

  const where = ['to_openid = ?']
  const params = [who]
  if (onlyUnread) where.push('is_read = 0')
  const whereSql = where.join(' AND ')

  const cnt = await queryOne(
    `SELECT COUNT(*) AS total FROM messages WHERE ${whereSql}`,
    params
  )
  const rows = await query(
    `SELECT id, type, title, content, ref_type, ref_id, ref_no, is_read, created_at
       FROM messages
      WHERE ${whereSql}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  )
  const unreadRow = await queryOne(
    'SELECT COUNT(*) AS n FROM messages WHERE to_openid = ? AND is_read = 0',
    [who]
  )

  return ok({
    list: toApi(rows),
    total: cnt.total,
    unread: num(unreadRow && unreadRow.n, 0),
    page,
    pageSize
  })
}

/** 未读数：首页红点用，必须轻量（只 COUNT，不取内容） */
async function unreadCount(ctx) {
  const who = myKey(ctx)
  if (!who) return ok({ unread: 0 })

  const row = await queryOne(
    'SELECT COUNT(*) AS n FROM messages WHERE to_openid = ? AND is_read = 0',
    [who]
  )
  return ok({ unread: num(row && row.n, 0) })
}

/** 标记单条已读（只能标自己的） */
async function markRead(ctx, data = {}) {
  const who = myKey(ctx)
  if (!who) return fail(401, '请先登录')

  const id = Number(data._id || data.id || 0)
  if (!id) return fail(400, '消息 ID 无效')

  const row = await queryOne(
    'SELECT id FROM messages WHERE id = ? AND to_openid = ?',
    [id, who]
  )
  if (!row) return fail(404, '消息不存在')

  await execute(
    'UPDATE messages SET is_read = 1, read_at = NOW() WHERE id = ? AND to_openid = ? AND is_read = 0',
    [id, who]
  )
  return ok({ _id: id })
}

/** 全部标记已读 */
async function markAllRead(ctx) {
  const who = myKey(ctx)
  if (!who) return fail(401, '请先登录')

  const res = await execute(
    'UPDATE messages SET is_read = 1, read_at = NOW() WHERE to_openid = ? AND is_read = 0',
    [who]
  )
  return ok({ updated: (res && res.affectedRows) || 0 })
}

module.exports = {
  name: 'message',
  roleRules: {},
  actions: { list, unreadCount, markRead, markAllRead }
}
