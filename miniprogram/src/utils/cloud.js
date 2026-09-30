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

// 开发模式：为 true 时跳过微信登录，直接使用下面的测试身份
// ⚠️ 正式上线前必须改成 false
export const DEV_MODE = true

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
 * 核心：调用后端接口
 * ============================================================ */

/**
 * 调用后端模块接口
 * @param {string} name   模块名：auth / material / outbound / inbound / check / stats / user ...
 * @param {string} action 动作名：submit / list / detail ...
 * @param {object} data   业务参数
 * @returns {Promise<any>} 直接 resolve 业务数据（与原云函数封装一致）
 */
export function callCloud(name, action, data = {}) {
  return new Promise((resolve, reject) => {
    // 幂等键：网络异常重试时，后端凭它识别为同一笔请求，不会重复出库
    const client_request_id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
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
          clearToken()
          reject(Object.assign(new Error(body.message || '登录已过期'), { code: 401 }))
          return
        }

        if (body.code === 0) {
          resolve(body.data)
        } else {
          const err = new Error(body.message || '请求失败')
          err.code = body.code
          reject(err)
        }
      },
      fail: (err) => {
        console.error(`[接口失败] ${name}.${action}`, err)
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
