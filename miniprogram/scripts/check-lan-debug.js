/**
 * 真机调试「局域网直连」体检
 * ------------------------------------------------------------
 * 真机调试慢（往返几百 ms、面板显示「连接方式：其他」）的根本原因只有一种：
 * 手机没和电脑处在同一局域网 → 微信开发者工具自动降级走「中转服务器」。
 * 这是网络链路问题，改代码救不了。
 *
 * 本脚本把「电脑侧」的前置条件一次查完，告诉你到底卡在哪：
 *   1. 本机有没有可用的局域网 IP（排除 WSL/虚拟网卡）
 *   2. 后端 3000 是否「局域网可达」（用真实 socket 连，不靠解析 netstat）
 *   3. 当前调试包里的 API_BASE 是不是这个局域网 IP（旧包 IP 会漂）
 *   4. 防火墙有没有放行微信开发者工具
 *
 * 用法：node scripts/check-lan-debug.js
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const net = require('net')
const { execSync } = require('child_process')

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m', x: '\x1b[0m', b: '\x1b[1m' }
const ok = (s) => `${C.g}✔${C.x} ${s}`
const bad = (s) => `${C.r}✘${C.x} ${s}`
const warn = (s) => `${C.y}!${C.x} ${s}`

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
  return all.find((c) => !c.virtual && PRIVATE.test(c.address))
    || all.find((c) => !c.virtual)
    || all[0] || null
}

/** 真实 TCP 连接探测：能连上才算通 */
function probe(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    let done = false
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v) } }
    s.setTimeout(timeout)
    s.once('connect', () => finish(true))
    s.once('timeout', () => finish(false))
    s.once('error', () => finish(false))
    try { s.connect(port, host) } catch { finish(false) }
  })
}

/** 拿一份 netstat 原始输出（含 LISTENING 行与 PID） */
function netstatRaw() {
  try {
    return execSync('netstat -ano', { encoding: 'buffer', windowsHide: true, timeout: 15000 })
      .toString('latin1')
  } catch { return '' }
}

;(async () => {
  console.log(`\n${C.b}═══ 真机调试 · 局域网直连体检 ═══${C.x}\n`)
  const problems = []
  const netstatAll = netstatRaw()

  // ── 1. 局域网 IP ────────────────────────────────────────────
  const lan = pickLanIp()
  console.log(`${C.b}[1] 本机局域网地址${C.x}`)
  if (!lan) {
    console.log(bad('没探测到任何局域网 IP'))
    problems.push('本机没有可用局域网 IP（检查 WiFi 是否连上）')
  } else if (lan.virtual) {
    console.log(warn(`只有虚拟网卡可用：${lan.address}（网卡 ${lan.name}）—— 手机连不上`))
    problems.push('物理网卡没拿到 IP（WiFi 断开？）')
  } else {
    console.log(ok(`${C.b}${lan.address}${C.x}（网卡 ${lan.name}）`))
  }
  const ip = lan ? lan.address : null

  // ── 2. 后端局域网可达性（真实连接） ─────────────────────────
  console.log(`\n${C.b}[2] 后端 3000 局域网可达性${C.x}`)
  const localOk = await probe('127.0.0.1', 3000)
  const lanOk = ip && ip !== '127.0.0.1' ? await probe(ip, 3000) : false
  if (localOk && lanOk) {
    console.log(ok(`本机 + 局域网（${ip}:3000）都能连 —— 手机侧可达`))
  } else if (localOk && !lanOk) {
    console.log(bad('本机连得上，但局域网 IP 连不上 —— 后端只绑了 127.0.0.1，或防火墙拦了 3000'))
    problems.push('后端未对局域网开放（需监听 0.0.0.0）或被防火墙拦截')
  } else {
    console.log(bad('3000 端口完全连不上 —— 后端没起来'))
    problems.push('后端服务未启动（计划任务 ShengLong-API）')
  }

  // ── 3. 调试包里的 API_BASE ──────────────────────────────────
  console.log(`\n${C.b}[3] 调试包 dist/build/mp-weixin 里的接口地址${C.x}`)
  const dist = path.join(__dirname, '..', 'dist', 'build', 'mp-weixin')
  if (!fs.existsSync(dist)) {
    console.log(bad('产物不存在 —— 先跑 npm run build:mp-dev'))
    problems.push('调试包未生成')
  } else {
    const found = new Set()
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name)
        if (f.isDirectory()) { walk(p); continue }
        if (!/\.(js|json|wxml|wxss)$/.test(f.name)) continue
        let txt = ''
        try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
        for (const m of txt.matchAll(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g)) found.add(m[0])
      }
    }
    walk(dist)
    const ips = [...found].filter((v) => !/^127\.|^0\.0\.0\.0$/.test(v))
    if (!ips.length) {
      console.log(warn('产物里没找到任何 IP（可能已是域名）'))
    } else if (ip && ips.includes(ip)) {
      console.log(ok(`命中当前局域网 IP：${ips.join(', ')}`))
    } else {
      console.log(bad(`产物里是 ${ips.join(', ')}，当前局域网 IP 是 ${ip}`))
      problems.push('调试包 IP 已过期 —— 重跑 npm run build:mp-dev')
    }
    const stale = ips.filter((v) => /^172\.(1[6-9]|2\d|3[01])\.|^10\./.test(v))
    if (stale.length) console.log(warn(`含疑似虚拟网卡残留：${stale.join(', ')} —— 建议重出包`))
  }

  // ── 4. 微信开发者工具的局域网通道 ───────────────────────────
  console.log(`\n${C.b}[4] 微信开发者工具局域网通道${C.x}`)
  const toolPorts = [...netstatAll.matchAll(/TCP\s+0\.0\.0\.0:(\d{4,5})\s+0\.0\.0\.0:0\s+LISTENING/gi)]
    .map((m) => Number(m[1]))
    .filter((p) => p >= 10000 && ![3000, 3307, 5176].includes(p))
  if (toolPorts.length) {
    console.log(ok(`已在 0.0.0.0:${toolPorts.join(', ')} 监听 —— 局域网通道开着，手机够得着`))
  } else {
    console.log(warn('没检测到局域网监听端口 —— 真机调试可能没启动，或只走了中转'))
    console.log(`${C.d}   在开发者工具里重新点一次「真机调试」再看${C.x}`)
  }
  console.log(`${C.d}   注：首次真机调试若 Windows 弹「防火墙」对话框，必须选「允许访问」${C.x}`)

  // ── 结论 ────────────────────────────────────────────────────
  console.log(`\n${C.b}═══ 结论 ═══${C.x}`)
  if (!problems.length) {
    console.log(`${C.g}${C.b}电脑侧一切就绪。${C.x}`)
    console.log('慢的原因在手机侧，按顺序检查：')
    console.log(`  1. 手机连的 WiFi 是否和电脑${C.b}同一个${C.x}（不是移动数据、不是另一个 SSID）`)
    console.log(`  2. 手机浏览器打开 ${C.b}http://${ip}:3000/api/health${C.x} —— 能出 JSON 才叫通`)
    console.log('  3. 路由器后台关掉「AP 隔离 / 无线客户端隔离」')
    console.log('  4. 真机调试面板里把「连接方式」选成「局域网」')
    console.log(`\n${C.d}  实在不行：电脑连手机热点，天然同网段；或日常用「预览」代替「真机调试」。${C.x}`)
  } else {
    console.log(`${C.r}${C.b}电脑侧有 ${problems.length} 个问题要先解决：${C.x}`)
    problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`))
  }
  console.log('')
})()
