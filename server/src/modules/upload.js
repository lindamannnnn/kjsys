/**
 * 文件上传模块（替代原云存储 uploadFile）
 * 前端以 base64 方式提交，服务端落盘到 UPLOAD_DIR，返回可访问 URL
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { ok, fail } = require('../utils/response')

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')

const ALLOW_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.xls', '.xlsx', '.csv']
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/** 生成安全的文件名，避免路径穿越 */
function safeName(originalName, fallbackExt = '.png') {
  const ext = path.extname(originalName || '').toLowerCase() || fallbackExt
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const rand = crypto.randomBytes(8).toString('hex')
  return `${stamp}_${rand}${ext}`
}

/** 上传文件：{ filename, base64, subdir } */
async function upload(ctx, data = {}) {
  const { filename, base64, subdir = 'materials' } = data

  if (!base64) return fail(400, '缺少文件内容')
  if (!ctx.user) return fail(401, '请先登录')

  const ext = path.extname(String(filename || '')).toLowerCase()
  if (ext && !ALLOW_EXT.includes(ext)) {
    return fail(400, `不支持的文件类型：${ext}`)
  }

  // 去掉 dataURL 前缀
  const pure = String(base64).replace(/^data:[^;]+;base64,/, '')
  let buffer
  try {
    buffer = Buffer.from(pure, 'base64')
  } catch (e) {
    return fail(400, '文件内容解析失败')
  }

  if (buffer.length > MAX_SIZE) {
    return fail(400, `文件超过大小限制（最大 ${MAX_SIZE / 1024 / 1024}MB）`)
  }

  const safeSubdir = String(subdir).replace(/[^a-zA-Z0-9_-]/g, '') || 'materials'
  const dir = path.join(UPLOAD_DIR, safeSubdir)
  ensureDir(dir)

  const name = safeName(filename)
  const fullPath = path.join(dir, name)

  try {
    fs.writeFileSync(fullPath, buffer)
  } catch (e) {
    return fail(500, `文件保存失败：${e.message}`)
  }

  const url = `/uploads/${safeSubdir}/${name}`

  return ok({
    fileid: url,     // 兼容原云存储字段名
    url,
    size: buffer.length,
    name
  }, '上传成功')
}

/** 删除已上传的文件 */
async function removeFile(ctx, data = {}) {
  const { url } = data
  if (!url) return fail(400, '缺少文件地址')

  const rel = String(url).replace(/^\/uploads\//, '')
  if (rel.includes('..')) return fail(400, '非法的文件地址')

  const fullPath = path.join(UPLOAD_DIR, rel)
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath)
  }
  return ok(null, '删除成功')
}

module.exports = {
  name: 'upload',
  publicActions: [],
  roleRules: {},
  actions: { upload, delete: removeFile }
}
