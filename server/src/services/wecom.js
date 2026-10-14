/**
 * ============================================================
 * 企业微信推送服务（2026-10-14 新增）
 * ------------------------------------------------------------
 * 目的：站内信工人不会主动去刷 —— 关键动作（该你确认/该你收货/盘点待审）
 *       要同步推到企业微信，让对应的人真的收到。
 *
 * 设计：
 *   - 走企业微信「自建应用」的应用消息 API（qyapi.weixin.qq.com）。
 *   - access_token 有 7200s 有效期，缓存复用，提前 5 分钟刷新。
 *   - **没配置企微就完全不影响系统**：isEnabled() 为 false 时一律跳过，
 *     站内信照发。推送失败也只记日志，绝不影响业务写库。
 *
 * 配置（生产 .env，缺一个就等于没启用）：
 *   WECOM_CORPID   企业ID（企业微信管理后台 → 我的企业）
 *   WECOM_AGENTID  自建应用的 AgentId
 *   WECOM_SECRET   自建应用的 Secret
 *
 * 员工绑定：users.wecom_userid 存企业微信账号（成员 UserID），
 *   在后台「用户管理」里给每个员工填。
 * ============================================================
 */
const https = require('https')

/* ---------------- 配置 ---------------- */
function conf() {
  return {
    corpid: (process.env.WECOM_CORPID || '').trim(),
    agentid: (process.env.WECOM_AGENTID || '').trim(),
    secret: (process.env.WECOM_SECRET || '').trim()
  }
}

/** 是否已配置企业微信（三样齐才算启用） */
function isEnabled() {
  const c = conf()
  return !!(c.corpid && c.agentid && c.secret)
}

/* ---------------- 底层 HTTPS ---------------- */
function httpsRequest(method, url, body = null, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : null
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {}
      },
      (resp) => {
        let raw = ''
        resp.on('data', (c) => { raw += c })
        resp.on('end', () => {
          try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('企微返回非 JSON：' + String(raw).slice(0, 200))) }
        })
      }
    )
    req.on('error', (e) => reject(new Error('连不上企业微信：' + e.message)))
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('企业微信请求超时')) })
    if (data) req.write(data)
    req.end()
  })
}

/* ---------------- access_token（带缓存） ---------------- */
let _token = ''
let _tokenExpireAt = 0

async function getAccessToken() {
  const now = Date.now()
  if (_token && now < _tokenExpireAt) return _token
  const c = conf()
  const res = await httpsRequest(
    'GET',
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(c.corpid)}&corpsecret=${encodeURIComponent(c.secret)}`
  )
  if (res.errcode !== 0) throw new Error(`企微取 token 失败：${res.errmsg}（errcode=${res.errcode}）`)
  _token = res.access_token
  // 提前 5 分钟刷新，避免临界点用到过期 token
  _tokenExpireAt = now + (Number(res.expires_in || 7200) - 300) * 1000
  return _token
}

/**
 * 给一批企微成员发文本消息
 * @param {string[]} userids 企微成员 UserID 列表
 * @param {string}   text    文本内容
 * @returns {Promise<{sent:number, errmsg:string}>}
 */
async function sendText(userids, text) {
  if (!isEnabled()) return { sent: 0, errmsg: '企业微信未配置' }
  const ids = Array.from(new Set((userids || []).filter(Boolean)))
  if (!ids.length || !text) return { sent: 0, errmsg: '无收件人或内容为空' }
  try {
    const token = await getAccessToken()
    const res = await httpsRequest(
      'POST',
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
      {
        touser: ids.join('|'),
        msgtype: 'text',
        agentid: Number(conf().agentid),
        text: { content: String(text).slice(0, 1900) },
        safe: 0
      }
    )
    if (res.errcode !== 0) {
      console.warn('[企微] 推送失败：', res.errcode, res.errmsg)
      return { sent: 0, errmsg: res.errmsg }
    }
    return { sent: ids.length, errmsg: 'ok' }
  } catch (e) {
    console.warn('[企微] 推送异常：', e.message)
    return { sent: 0, errmsg: e.message }
  }
}

module.exports = { isEnabled, sendText, getAccessToken }
