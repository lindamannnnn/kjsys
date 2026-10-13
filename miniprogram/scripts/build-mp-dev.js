/**
 * 出「开发者工具本地调试包」
 * ------------------------------------------------------------
 * 与正式包（npm run build:mp-weixin）的区别：
 *   - FORCE_DEV_LOGIN=true → 保留测试身份一键登录、退出登录直接换岗位
 *   - API_BASE 指向本机服务（局域网 IP:3000），不调生产服务器
 *
 * ⚠️ 这个包只用于微信开发者工具里调试，绝不能提交审核。
 *    提审出包用 npm run build:mp-weixin，出完跑 node scripts/pre-submit-check.js 复核。
 *
 * ── 为什么 API_BASE 必须是「局域网 IP」而不是 127.0.0.1 ────────────────
 *   开发者工具的「模拟器」和后端跑在同一台电脑上，写 127.0.0.1 能通；
 *   但「真机调试 / 预览」时，127.0.0.1 在手机里指的是**手机自己**，
 *   手机会去连它自己的 3000 端口 → 必然失败，界面表现就是
 *   「网络异常，请检查网络后重试」（cloud.js 的 request fail 分支）。
 *   所以这里默认自动探测本机局域网 IP，模拟器与真机都能用。
 *
 *   前提：手机与电脑连同一个 WiFi / 同一局域网。
 *   电脑换网络后 IP 会变，重跑一次本脚本即可。
 *
 * 用法：
 *   node scripts/build-mp-dev.js                        # 自动探测局域网 IP
 *   API_BASE=http://192.168.1.200:3000 node scripts/build-mp-dev.js   # 手动指定
 */
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

/**
 * 挑一个「真机够得着」的局域网 IPv4。
 * 排除 WSL / Hyper-V / VirtualBox / VMware / Docker 之类的虚拟网卡 ——
 * 那些地址手机连不上，选错了照样网络异常。
 */
function pickLanIp() {
  const VIRTUAL = /wsl|hyper-v|vethernet|virtualbox|vmware|docker|loopback|tailscale|zerotier|bluetooth/i
  const PRIVATE = /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./
  const all = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue
      all.push({ name, address: i.address, virtual: VIRTUAL.test(name) })
    }
  }
  // 优先「非虚拟 + 私有网段」，退化到「非虚拟」，再退化到任意
  const pick = all.find((c) => !c.virtual && PRIVATE.test(c.address))
    || all.find((c) => !c.virtual)
    || all[0]
  return pick ? { ip: pick.address, iface: pick.name } : { ip: '', iface: '' }
}

process.env.FORCE_DEV_LOGIN = 'true'

if (!process.env.API_BASE) {
  const { ip, iface } = pickLanIp()
  process.env.API_BASE = ip ? `http://${ip}:3000` : 'http://127.0.0.1:3000'
  if (ip) {
    console.log(`\n📡 探测到局域网地址：${ip}（网卡 ${iface}）`)
  } else {
    console.log('\n⚠️ 没探测到局域网 IP，回退 127.0.0.1 —— 真机会连不上，只能用模拟器')
  }
}

const apiBase = process.env.API_BASE

const cli = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'uni.cmd' : 'uni')
const child = spawn(cli, ['build', '-p', 'mp-weixin'], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.join(__dirname, '..'),
  shell: process.platform === 'win32'
})

child.on('exit', (code) => {
  if (code === 0) {
    console.log('\n✅ 调试包已出：dist/build/mp-weixin')
    console.log('   测试身份：开（退出登录可直接换岗位）')
    console.log(`   接口地址：${apiBase}`)
    console.log('')
    console.log('   微信开发者工具点「编译」即可（模拟器 / 真机调试都能连）。')
    // 提示要跟着接口类型走：局域网地址才需要同一 WiFi，公网/隧道地址则看隧道和服务
    const isLan = /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(apiBase)
    if (isLan) {
      console.log('   真机调试前提：手机与本机连同一个 WiFi。')
      console.log('   手机用流量测 → 改用 npm run build:mp-tunnel（走公网隧道）')
    } else {
      console.log('   手机流量测试包：手机无需连 WiFi，走公网隧道。')
      console.log('   前提：本机隧道在跑 + 服务器 shenglong-tunnel80 服务在跑。')
    }
    console.log('   提审请改用 npm run build:mp-weixin')
  }
  process.exit(code || 0)
})
