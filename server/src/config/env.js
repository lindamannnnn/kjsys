/**
 * 统一的环境变量加载器
 * ------------------------------------------------------------
 * 问题背景：dotenv 默认按「当前工作目录」找 .env
 *   （内部实现是 path.resolve(process.cwd(), '.env')）
 * 于是 `cd server && node src/app.js` 能读到配置，
 * 但 `node server/tests/api-test.js`（从项目根执行）读不到，
 * 会静默退回默认值（DB 端口 3306），表现为莫名其妙的 ECONNREFUSED。
 *
 * 解决：始终以本文件位置为锚点定位 server/.env，与启动目录无关。
 * 所有入口（app / 各类脚本 / 测试）统一 require 本模块，不要再直接
 * 调用 require('dotenv').config()。
 */
const path = require('path')
const fs = require('fs')

const ENV_PATH = path.resolve(__dirname, '../../.env')

require('dotenv').config({ path: ENV_PATH })

const loaded = fs.existsSync(ENV_PATH)

// 容器环境（Docker）下 .env 是被刻意排除的，配置由 docker-compose 注入。
// 只有「既没有 .env 文件、也没有外部注入数据库配置」时才值得警告，
// 否则会误导运维去容器里放 .env（那样反而会把密钥烧进镜像）。
const injected = Boolean(process.env.DB_HOST && process.env.DB_PASSWORD)

if (!loaded && !injected) {
  console.warn(`[env] 未找到配置文件：${ENV_PATH}`)
  console.warn('[env] 未检测到外部注入的数据库配置，将使用内置默认值（DB 端口 3306）')
  console.warn('[env] 本机开发：请复制 server/.env.example 为 server/.env')
}

/**
 * 读取必填项，缺失时抛错（避免把错误配置带到运行时）
 * @param {string} key
 */
function required(key) {
  const val = process.env[key]
  if (!val) throw new Error(`[env] 缺少必填配置：${key}（请检查 ${ENV_PATH}）`)
  return val
}

module.exports = {
  ENV_PATH,
  loaded,
  required,
  get: (key, def = undefined) => (process.env[key] !== undefined ? process.env[key] : def)
}
