/**
 * ============================================================
 * 接口调用封装（自建服务器版）
 * ------------------------------------------------------------
 * 替代原微信云开发的 wx.cloud.callFunction。
 * 保持 callCloud(name, action, data) 的函数签名与返回结构不变，
 * 因此各业务页面的调用代码无需改动。
 * ============================================================
 */

/* ============================================================
 * 配置区 —— 换环境只需要改这里
 * ============================================================ */

// 后端接口地址
//   开发者工具模拟器：localhost 和局域网 IP 都能连（同一台机器）
//   手机真机：必须写局域网 IP，写 localhost 手机连的是它自己，一定连不通
//   生产/体验版：腾讯云轻量服务器（域名备案完成后换成 https 域名）
//
// ⚠️ 本地联调改回局域网 IP 后重新编译；服务器部署走 http://119.91.206.235:3000
const API_BASE = 'http://119.91.206.235:3000'

// 开发登录开关：不再写死，由构建配置在编译期注入（见 vite.config.js 的 define）
//   - 本地开发 / H5 浏览器联调 → true，可用下面的测试身份直接登录，不依赖微信 API
//   - 小程序生产构建（即提交微信审核的那一份）→ false，强制走真实微信登录
//
// ⚠️ 兜底侧刻意取 false：万一常量没被注入，宁可关掉开发登录，
//    也不能让它悄悄出现在提交审核的包里（曾因此被微信以「未浏览即强制授权登录」驳回）。
export const DEV_MODE = typeof __DEV_LOGIN__ !== 'undefined' ? __DEV_LOGIN__ : false

// 开发模式下的默认身份标识
// 可在「我的」页面里切换，切换结果存在本地，不用改代码重新编译
// 可选身份由 server/src/db/seed-dev.js 创建（npm run seed:dev）
const DEV_OPENID = 'dev_worker_01'
const DEV_OPENID_KEY = 'sl_dev_openid'

/** 当前开发身份（没切换过就用默认值） */
export function getDevOpenid() {
  if (!DEV_MODE) return ''
  try {
    return uni.getStorageSync(DEV_OPENID_KEY) || DEV_OPENID
  } catch (e) {
    return DEV_OPENID
  }
}

/** 切换开发身份（存起来，下次登录生效） */
export function setDevOpenid(openid) {
  try {
    if (openid) uni.setStorageSync(DEV_OPENID_KEY, openid)
    else uni.removeStorageSync(DEV_OPENID_KEY)
  } catch (e) {
    // ignore
  }
}

/** 可选开发身份清单（与 server/src/db/seed-dev.js 一一对应） */
export const DEV_IDENTITIES = [
  { openid: 'dev_worker_01', label: '全能', desc: '出库 + 入库 + 仓管 + 采购' },
  { openid: 'dev_out', label: '出库员', desc: '只提交出库单' },
  { openid: 'dev_in', label: '入库员', desc: '只提交入库单' },
  { openid: 'dev_sk', label: '仓管', desc: '确认/驳回单据、盘点' },
  { openid: 'dev_purchase', label: '采购', desc: '采购入库、库存流水对账' },
  { openid: 'dev_boss', label: '老板', desc: '看板、预警、全部单据' }
]

/* ============================================================
 * 令牌管理
 * ============================================================ */
const TOKEN_KEY = 'sl_token'
const USER_KEY = 'sl_user'

export function getToken() {
  try {
    return uni.getStorageSync(TOKEN_KEY) || ''
  } catch (e) {
    return ''
  }
}

export function setToken(token) {
  try {
    if (token) uni.setStorageSync(TOKEN_KEY, token)
    else uni.removeStorageSync(TOKEN_KEY)
  } catch (e) {
    // ignore
  }
}

export function clearToken() {
  setToken('')
  try {
    uni.removeStorageSync(USER_KEY)
  } catch (e) {
    // ignore
  }
}

/* ============================================================
 * 幂等键管理（防重复下单的关键）
 * ------------------------------------------------------------
 * 后端靠 client_request_id 识别「这是不是同一笔请求」。所以只有
 * 同一笔业务提交复用同一个键，幂等才真的起作用。
 *
 * ⚠️ 曾经的写法是每次请求都现生成一个键 —— 等于每次都告诉后端
 *    「这是一笔新请求」，幂等完全失效：网络超时后用户一点重试、
 *    或者手快连点两下，后端就老老实实出两张单。
 *
 * 现在按「模块 + 动作 + 参数」指纹复用：
 *   - 确定成功（后端返回 code 0）→ 立即作废，下次同参数是新的一笔
 *   - 确定失败（后端返回业务错误码）→ 作废，因为事务已回滚
 *   - 结果未知（网络异常 / 超时）→ 保留，用户重试时复用同一个键，
 *     后端查到这个键已有单据会直接返回原单，不会重复出库
 *
 * 并发连点天然被覆盖：两次点击参数一致 → 指纹一致 → 同一个键。
 * ============================================================ */

// 最多缓存多少笔「结果未知」的键，超出按最早淘汰，避免长期运行内存膨胀
const IDEMPOTENCY_MAX = 50
const pendingRequestKeys = new Map()

/** 稳定序列化：对象键排序，避免键顺序不同导致指纹不同 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 取（必要时新建）本次提交的幂等键 */
function acquireRequestId(name, action, data) {
  const fingerprint = `${name}.${action}::${stableStringify(data)}`
  let requestId = pendingRequestKeys.get(fingerprint)
  if (!requestId) {
    requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    if (pendingRequestKeys.size >= IDEMPOTENCY_MAX) {
      // Map 保持插入顺序，第一个就是最早的
      pendingRequestKeys.delete(pendingRequestKeys.keys().next().value)
    }
    pendingRequestKeys.set(fingerprint, requestId)
  }
  return { fingerprint, requestId }
}

/** 结果已明确（成功或业务失败）→ 作废该键；结果未知则保留供重试复用 */
function settleRequestId(fingerprint) {
  if (fingerprint) pendingRequestKeys.delete(fingerprint)
}

/* ============================================================
 * 核心：调用后端接口
 * ============================================================ */

/**
 * 调用后端模块接口
 * @param {string} name      模块名：auth / material / outbound / inbound / check / stats / user ...
 * @param {string} action    动作名：submit / list / detail ...
 * @param {object} data      业务参数
 * @param {object} [options] 可选：{ client_request_id } 显式指定幂等键（一般不用传）
 * @returns {Promise<any>} 直接 resolve 业务数据（与原云函数封装一致）
 */
export function callCloud(name, action, data = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const explicitId = options && options.client_request_id
    const { fingerprint, requestId: client_request_id } = explicitId
      ? { fingerprint: '', requestId: String(explicitId) }
      : acquireRequestId(name, action, data)
    const token = getToken()

    const header = { 'Content-Type': 'application/json' }
    if (token) header.Authorization = `Bearer ${token}`

    uni.request({
      url: `${API_BASE}/api/${name}`,
      method: 'POST',
      header,
      timeout: 30000,
      data: { action, data, client_request_id },
      success: (res) => {
        const body = res.data || {}

        // 令牌失效：清掉本地登录态，让页面跳回登录
        if (body.code === 401) {
          settleRequestId(fingerprint)
          clearToken()
          reject(Object.assign(new Error(body.message || '登录已过期'), { code: 401 }))
          return
        }

        if (body.code === 0) {
          // 确定成功 → 作废幂等键，下一次同参数提交才是新的一笔
          settleRequestId(fingerprint)
          // 后端识别出这是重复提交（上一次其实已成功）时给出标记，页面可提示得更准确
          if (body.data && typeof body.data === 'object' && body.data.duplicated) {
            body.data.__duplicated = true
          }
          resolve(body.data)
        } else {
          // 确定失败：后端事务已回滚，这笔没生效，作废键让用户重试时是一笔新的
          settleRequestId(fingerprint)
          const err = new Error(body.message || '请求失败')
          err.code = body.code
          reject(err)
        }
      },
      fail: (err) => {
        // 结果未知（超时 / 断网 / 服务无响应）→ 保留幂等键。
        // 用户重试时复用同一个键，后端若发现这笔其实已入库会返回原单，不会出双单。
        console.error(`[接口失败，结果未知，重试将复用同一幂等键] ${name}.${action}`, err)
        const e = new Error('网络异常，请检查网络后重试')
        e.code = -1
        e.raw = err
        reject(e)
      }
    })
  })
}

/* ============================================================
 * 微信登录
 * ============================================================ */

/** 获取微信登录 code（小程序端） */
function getWxCode() {
  return new Promise((resolve, reject) => {
    uni.login({
      provider: 'weixin',
      success: (res) => {
        if (res.code) resolve(res.code)
        else reject(new Error('获取微信登录凭证失败'))
      },
      fail: () => reject(new Error('微信登录失败，请重试'))
    })
  })
}

/**
 * 登录并保存令牌
 * 开发模式下不调微信接口，直接用测试身份，便于本地联调
 * @returns {Promise<object>} { openid, user, roles, isNew, token }
 */
export async function loginWithWechat() {
  let payload = {}

  if (DEV_MODE) {
    payload = { dev_openid: getDevOpenid() }
  } else {
    const code = await getWxCode()
    payload = { code }
  }

  const res = await callCloud('auth', 'login', payload)

  if (res && res.token) {
    setToken(res.token)
  }
  if (res && res.user) {
    try {
      uni.setStorageSync(USER_KEY, res.user)
    } catch (e) {
      // ignore
    }
  }

  return res
}

/* ============================================================
 * 文件上传（替代原云存储）
 * ============================================================ */

/**
 * 上传文件
 * @param {string} filePath 本地文件路径
 * @param {string} subdir   服务端子目录，如 materials
 * @returns {Promise<string>} 可访问的文件地址
 */
export function uploadFile(filePath, subdir = 'materials') {
  return new Promise((resolve, reject) => {
    // 先读取为 base64，再提交给后端（避免小程序域名白名单里还要配置 uploadFile）
    uni.getFileSystemManager
      ? uni.getFileSystemManager().readFile({
          filePath,
          encoding: 'base64',
          success: (r) => {
            const name = String(filePath).split('/').pop() || 'file.png'
            callCloud('upload', 'upload', { filename: name, base64: r.data, subdir })
              .then((res) => resolve(res.url))
              .catch(reject)
          },
          fail: () => reject(new Error('读取文件失败'))
        })
      : reject(new Error('当前环境不支持文件上传'))
  })
}

/** 兼容原接口：云存储临时链接 → 直接返回原地址 */
export function getTempFileURL(fileList) {
  const list = Array.isArray(fileList) ? fileList : [fileList]
  return Promise.resolve(list.map((fileID) => ({ fileID, tempFileURL: fileID })))
}

/** 拼出完整文件地址（服务端返回的是相对路径） */
export function fullFileUrl(url) {
  if (!url) return ''
  if (/^https?:\/\//.test(url)) return url
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`
}

export { API_BASE }
