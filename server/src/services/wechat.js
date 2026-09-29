/**
 * 微信接口封装
 * 原云开发由平台自动注入 openid；自建后端需自己用 code 换 openid
 */
const https = require('https')
const { errors } = require('../utils/response')

/** 简单的 HTTPS GET → JSON */
function httpGetJson(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (resp) => {
      let raw = ''
      resp.on('data', (c) => {
        raw += c
      })
      resp.on('end', () => {
        try {
          resolve(JSON.parse(raw))
        } catch (e) {
          reject(errors.server(`微信接口返回异常：${String(raw).slice(0, 200)}`))
        }
      })
    })
    req.on('error', (e) => reject(errors.server(`无法连接微信接口：${e.message}`)))
    req.setTimeout(timeout, () => {
      req.destroy()
      reject(errors.server('微信接口请求超时'))
    })
  })
}

/**
 * code2session：小程序 wx.login 拿到的 code → openid
 * @param {string} code
 * @returns {Promise<{openid:string, sessionKey:string, unionid:string}>}
 */
async function code2session(code) {
  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET

  if (!appid || !secret) {
    throw errors.server('服务端未配置微信 AppID/AppSecret，无法使用微信登录')
  }
  if (!code) {
    throw errors.badRequest('缺少微信登录 code')
  }

  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    '&grant_type=authorization_code'

  const res = await httpGetJson(url)

  if (res.errcode) {
    // 常用错误码解释，便于排查
    const tips = {
      '-1': '微信系统繁忙，稍后重试',
      40029: 'code 无效或已使用（请确认前端重新 wx.login 获取）',
      45011: '请求过于频繁，请稍后重试',
      40226: '登录受限，该用户被微信风控',
      40013: 'AppID 无效',
      40125: 'AppSecret 无效'
    }
    const tip = tips[res.errcode] || res.errmsg || '未知错误'
    throw errors.badRequest(`微信登录失败(${res.errcode})：${tip}`)
  }

  if (!res.openid) {
    throw errors.badRequest('微信登录失败：未获取到 openid')
  }

  return {
    openid: res.openid,
    sessionKey: res.session_key || '',
    unionid: res.unionid || ''
  }
}

/** 是否允许开发模式登录（本地测试用，生产必须为 false） */
function isDevLoginAllowed() {
  return String(process.env.ALLOW_DEV_LOGIN || '').toLowerCase() === 'true'
}

module.exports = { code2session, isDevLoginAllowed, httpGetJson }
