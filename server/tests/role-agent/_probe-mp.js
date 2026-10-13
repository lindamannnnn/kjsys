/**
 * 一次性探针：验证 miniprogram-automator 能连上微信开发者工具并驱动项目。
 * 只做最小验证：launch/connect → 拿到当前页面栈 → 截一张图存盘。
 *
 * 用法：node tests/role-agent/_probe-mp.js
 * ⚠️ 前提：开发者工具的「设置 → 安全设置 → 服务端口」已打开。
 */
const path = require('path')
const fs = require('fs')

const automator = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator')

const CLI = 'E:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat'
const PROJECT = 'G:\\sl\\shenglong-erp\\miniprogram\\dist\\build\\mp-weixin'
const PORT = 9420

;(async () => {
  console.log('== automator.connect 直连 9420（项目已由 cli auto 打开并挂自动化端口） ==')
  let mp
  try {
    mp = await automator.connect({ wsEndpoint: `ws://localhost:${PORT}` })
  } catch (e) {
    console.error('connect 失败：', e.message)
    console.error('→ 先跑一次：cli.bat auto --project <产物目录> --auto-port 9420')
    process.exit(1)
  }
  console.log('✅ 已连接')

  const page = await mp.currentPage()
  console.log('当前页面：', page.path, 'query=', JSON.stringify(page.query || {}))

  // 真小程序环境里执行 JS：读 storage 里的开发身份
  const openid = await mp.evaluate(() => {
    try { return wx.getStorageSync('sl_dev_openid') || '(空)' } catch (e) { return '(读取失败)' }
  })
  console.log('storage 里的开发身份：', openid)

  const shot = path.join(process.cwd(), 'tests/role-agent/results/_mp-probe.png')
  fs.mkdirSync(path.dirname(shot), { recursive: true })
  await mp.screenshot({ path: shot })
  console.log('截图已存：', shot)

  await mp.close()
  console.log('✅ 探针完成')
  process.exit(0)
})().catch((e) => { console.error('探针异常：', e); process.exit(1) })
