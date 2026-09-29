#!/usr/bin/env node
/**
 * ============================================================
 * 用微信开发者工具打开小程序项目
 * ------------------------------------------------------------
 * 解决一个反复踩的坑：
 *   uni-app 的源码根目录（miniprogram/）里**没有 app.json**，
 *   编译产物才在 dist/build/mp-weixin/ 下。
 *   如果直接用开发者工具「导入项目」选中 miniprogram/，
 *   启动模拟器就会报「在项目根目录未找到 app.json」。
 *
 * 用法：
 *   npm run mp:open           打开编译产物目录（推荐，必然可用）
 *   npm run mp:open -- --root 打开源码根目录（靠 project.config.json
 *                             里的 miniprogramRoot 兜底）
 *
 * 依赖：微信开发者工具已安装，且已开启「服务端口」
 *       （工具里：设置 → 安全设置 → 服务端口 → 打开）
 * ============================================================
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

/* ---------- 1. 找到开发者工具的 cli.bat ---------- */
const CANDIDATES = [
  process.env.WECHAT_DEVTOOLS_CLI,
  'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
  'C:/Program Files/Tencent/微信web开发者工具/cli.bat',
  'D:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
  'D:/Program Files/Tencent/微信web开发者工具/cli.bat',
  'E:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
  'E:/Program Files/Tencent/微信web开发者工具/cli.bat',
  'F:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
  'F:/Program Files/Tencent/微信web开发者工具/cli.bat'
].filter(Boolean)

const cliPath = CANDIDATES.find((p) => fs.existsSync(p))

/* ---------- 2. 决定要打开哪个目录 ---------- */
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist', 'build', 'mp-weixin')
const useRoot = process.argv.includes('--root')
const projectDir = useRoot ? rootDir : distDir

/* ---------- 3. 前置检查 ---------- */
if (!fs.existsSync(path.join(distDir, 'app.json'))) {
  console.error('')
  console.error('✗ 还没有编译产物：' + distDir)
  console.error('  请先执行：npm run build:mp-weixin')
  console.error('')
  process.exit(1)
}

if (!cliPath) {
  console.error('')
  console.error('✗ 没找到微信开发者工具的 cli.bat（已找过 C/D/E/F 盘的常见路径）')
  console.error('')
  console.error('  两个办法二选一：')
  console.error('  ① 手动导入：打开微信开发者工具 → 导入项目 → 目录选：')
  console.error('     ' + distDir)
  console.error('  ② 把 cli.bat 的完整路径写进环境变量 WECHAT_DEVTOOLS_CLI 后重试')
  console.error('')
  process.exit(1)
}

/* ---------- 4. 打开 ---------- */
console.log('')
console.log('用微信开发者工具打开：')
console.log('  ' + projectDir)
console.log('（' + (useRoot ? '源码根目录，靠 miniprogramRoot 指向产物' : '编译产物目录') + '）')
console.log('')

// 为什么要把输出重定向到文件：
//   工具的 cli.bat 会把自己的输出直连控制台，spawnSync 的 pipe 抓不到，
//   而且它在「服务端口关闭」时**也返回退出码 0**，只看 status 会误判成成功。
//   重定向到文件才能真正读到它在说什么。
const logFile = path.join(os.tmpdir(), 'mp-open-' + Date.now() + '.log')
const cmd =
  '"' + cliPath + '" open --project "' + projectDir + '" > "' + logFile + '" 2>&1'

spawnSync(cmd, { shell: true, stdio: 'ignore' })

let output = ''
try {
  output = fs.readFileSync(logFile, 'utf8')
} catch (e) {
  output = ''
}
try {
  fs.unlinkSync(logFile)
} catch (e) {
  // 删不掉也无所谓，在临时目录里
}

// 只认英文关键词：中文在 Windows 控制台是 GBK，转 utf8 会乱码
const portDisabled = /service port disabled|Service Port On/i.test(output)
const ok = !portDisabled && !/\[error\]/i.test(output)

if (ok) {
  console.log('')
  console.log('✓ 开发者工具已打开上面这个目录。')
  console.log('')
  process.exit(0)
}

console.error('')
console.error('✗ 命令行没能自动打开：' + (portDisabled ? '工具的「服务端口」是关闭的' : '工具返回了错误'))
console.error('  下面两种办法选一个，都能让模拟器跑起来：')
console.error('')
console.error('  【办法 1】手动导入，不用改任何设置（推荐，只需做一次）')
console.error('    微信开发者工具 → 项目 → 导入项目 → 目录填：')
console.error('      ' + projectDir)
console.error('')
console.error('  【办法 2】开启服务端口，以后就能用 npm run mp:open 一键打开')
console.error('    工具 → 设置 → 安全设置 → 服务端口 → 打开')
console.error('')
process.exit(1)
