/**
 * ============================================================
 * 列出企业微信通讯录成员（拿 UserID，用来在后台绑定账号）
 * ------------------------------------------------------------
 * 用途：后台「用户管理」里要给每个员工填「企微账号」，
 *       但 UserID 在企业微信后台要一个个点进去看，很烦。
 *       这个脚本一次把「部门 + 姓名 + UserID」全列出来，复制粘贴即可。
 *
 * 用法（在 server/ 目录下）：
 *   node scripts/wecom-list-users.js
 *   node scripts/wecom-list-users.js --json          # 输出 JSON，便于程序处理
 *   node scripts/wecom-list-users.js --dept 1        # 只在某个部门下找（默认根部门 1）
 *
 * 前置：server/.env 里 WECOM_CORPID / WECOM_AGENTID / WECOM_SECRET 三样齐；
 *       ⚠️ 且**本机/服务器出口 IP 必须在企微后台的「企业可信IP」里**，
 *          否则会报 60020 not allow to access from your ip。
 *
 * 常见报错：
 *   60020 → IP 没加白名单（去企微后台 → 应用 → 自建应用 → 企业可信IP）
 *   60011 → 该应用没有通讯录读取权限（企微后台给应用勾「通讯录」权限，或直接用通讯录同步助手的 secret）
 *   40013 → corpid 不对
 * ============================================================
 */
require('../src/config/env')
const https = require('https')

function conf() {
  return {
    corpid: (process.env.WECOM_CORPID || '').trim(),
    agentid: (process.env.WECOM_AGENTID || '').trim(),
    secret: (process.env.WECOM_SECRET || '').trim()
  }
}

function req(url, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : null
    const r = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: data ? 'POST' : 'GET',
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {}
      },
      (resp) => {
        let raw = ''
        resp.on('data', (c) => { raw += c })
        resp.on('end', () => {
          try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('返回非 JSON：' + raw.slice(0, 200))) }
        })
      }
    )
    r.on('error', reject)
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('请求超时')) })
    if (data) r.write(data)
    r.end()
  })
}

async function main() {
  const asJson = process.argv.includes('--json')
  const di = process.argv.indexOf('--dept')
  const deptId = di > -1 ? Number(process.argv[di + 1]) : 1

  const c = conf()
  if (!c.corpid || !c.secret) {
    console.error('✗ server/.env 里 WECOM_CORPID / WECOM_SECRET 没配齐')
    process.exit(1)
  }

  const tok = await req(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(c.corpid)}&corpsecret=${encodeURIComponent(c.secret)}`
  )
  if (tok.errcode !== 0) {
    console.error(`✗ 取 token 失败：${tok.errmsg}（errcode=${tok.errcode}）`)
    process.exit(1)
  }
  const token = tok.access_token

  const dep = await req(`https://qyapi.weixin.qq.com/cgi-bin/department/simplelist?access_token=${token}`)
  if (dep.errcode !== 0) {
    console.error(`✗ 读部门失败：${dep.errmsg}（errcode=${dep.errcode}）`)
    if (dep.errcode === 60020) console.error('  → IP 没加进企微「企业可信IP」')
    if (dep.errcode === 60011) console.error('  → 该应用没有通讯录权限')
    process.exit(1)
  }
  const deptName = {}
  for (const d of dep.department_list || []) deptName[d.id] = d.name

  const usr = await req(
    `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=${deptId}&fetch_child=1`
  )
  if (usr.errcode !== 0) {
    console.error(`✗ 读成员失败：${usr.errmsg}（errcode=${usr.errcode}）`)
    process.exit(1)
  }
  const list = usr.userlist || []

  if (asJson) {
    console.log(JSON.stringify(list.map((u) => ({
      userid: u.userid, name: u.name, mobile: u.mobile, departments: u.department
    })), null, 2))
    return
  }

  console.log('='.repeat(64))
  console.log(`  企业微信通讯录 · 共 ${list.length} 人（部门 ${deptId} 及子部门）`)
  console.log('='.repeat(64))
  console.log('  UserID（填后台用）        姓名        部门')
  console.log('-'.repeat(64))
  for (const u of list) {
    const ds = (u.department || []).map((d) => deptName[d] || d).join('/')
    console.log(`  ${String(u.userid).padEnd(24)} ${String(u.name).padEnd(10)} ${ds}`)
  }
  console.log('-'.repeat(64))
  console.log('  把左边 UserID 填到：后台 → 用户管理 → 编辑该员工 → 企微账号')
  console.log('='.repeat(64))
}

main().catch((e) => { console.error('✗ 出错：', e.message); process.exit(1) })
