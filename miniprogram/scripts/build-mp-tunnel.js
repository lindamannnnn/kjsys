/**
 * 出「手机流量测试包」
 * ------------------------------------------------------------
 * 和 build-mp-dev.js 的唯一区别：接口不指本机局域网 IP，而是指
 * 腾讯云上的**反向隧道地址** —— 手机用 4G（不连 WiFi）也能连到你本机后端。
 *
 * 链路：
 *   手机 4G → http://119.91.206.235 （80 端口）
 *            → 服务器 shenglong-tunnel80 服务
 *            → 127.0.0.1:13000 （SSH 反向隧道）
 *            → 开发机 3000（本机开发后端 + 本地库）
 *
 * 为什么用 80：腾讯云只放行了 22 / 80，而 80 是特权端口，
 *   SSH 的 -R 绑不上，所以在服务器上另起了一个 root 常驻转发进程。
 *   好处是你**不用去腾讯云控制台开任何端口**。
 *
 * ⚠️ 用之前必须两个条件都满足，否则手机上表现为「网络异常」：
 *   1. 本机隧道在跑：bash G:/sl/tools/tunnel.sh
 *   2. 服务器转发服务在跑：sudo systemctl status shenglong-tunnel80（应 active）
 *   自测（本机执行，注意沙箱要走 --noproxy）：
 *     curl -s --noproxy '*' http://119.91.206.235/api/health
 *   返回的 uptime 应该跟本机 3000 接近（不是生产那个大数字）才算对。
 *
 * 用法：
 *   npm run build:mp-tunnel                 # 默认隧道地址
 *   API_BASE=http://其他地址 node scripts/build-mp-tunnel.js
 *
 * 连 WiFi 时想更快，用 npm run build:mp-dev（走局域网直连）。
 */
process.env.API_BASE = process.env.API_BASE || 'http://119.91.206.235'

console.log(`\n📡 手机流量测试包 —— 接口指向隧道：${process.env.API_BASE}`)
console.log('   前提：本机隧道在跑 + 服务器 shenglong-tunnel80 服务在跑\n')

require('./build-mp-dev.js')
