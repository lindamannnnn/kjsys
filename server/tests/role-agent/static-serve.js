/**
 * 静态托管小工具（UI 测试专用）
 * 用法：node tests/role-agent/static-serve.js <目录> <端口> [URL前缀]
 * 特性：SPA 回退（找不到文件且不像资源路径时回 index.html）+ Cache-Control: no-store
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const DIR = path.resolve(process.argv[2])
const PORT = Number(process.argv[3] || 5175)
// 前缀归一化为「带前导斜杠、无尾斜杠」，兼容传 admin 或 /admin 两种写法
let PREFIX = process.argv[4] || ''
if (PREFIX && !PREFIX.startsWith('/')) PREFIX = `/${PREFIX}`
if (PREFIX.endsWith('/')) PREFIX = PREFIX.slice(0, -1)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (PREFIX && p.startsWith(PREFIX)) p = p.slice(PREFIX.length) || '/'
  let file = path.join(DIR, p === '/' ? 'index.html' : p)
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end() }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA 回退：带扩展名的按 404，其余回 index.html
    if (path.extname(p)) { res.writeHead(404); return res.end('not found') }
    file = path.join(DIR, 'index.html')
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
  })
  fs.createReadStream(file).pipe(res)
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${DIR} at http://127.0.0.1:${PORT}${PREFIX}`))
