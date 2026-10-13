/**
 * ============================================================
 * V2 测试 · P0 独立复核脚本
 * ------------------------------------------------------------
 * 岗位 Agent 报了两条 P0，本脚本不靠它们的结论，自己打真实接口复现：
 *
 *  【复核 1】老板能不能给自己/别人提权成管理员（agent 王总报的）
 *     做法：用老板账号给一个开发账号设 roles=['admin'] → 看返回 → 立刻改回原值
 *
 *  【复核 2】消息中心到底是「功能坏了」还是「测试账号没有 openid」
 *     背景：张三/李娜/赵六都用账号密码登录，openid 为 NULL；
 *           而 dev_* 账号有 openid。
 *     做法：让有 openid 的 dev_out 提单 → dev_sk 确认并拣货（会触发通知）
 *           → 查 dev_out 的收件箱。若收到 = 功能正常，报的是环境假问题。
 *
 * 用法：node tests/v2-p0-recheck.js
 * ============================================================
 */
require('../src/config/env')

const http = require('http')
const fs = require('fs')
const path = require('path')

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'
const CTX_FILE = path.join(__dirname, 'v2-test-context.json')

function call(moduleName, action, data = {}, token = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ action, data })
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(
      `${BASE}/api/${moduleName}`,
      { method: 'POST', headers, timeout: 20000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (e) {
            reject(new Error(`响应非 JSON：${raw.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
    req.write(payload)
    req.end()
  })
}

const results = []

async function main() {
  const ctx = JSON.parse(fs.readFileSync(CTX_FILE, 'utf8'))
  const matBySpec = {}
  ctx.测试物料.forEach((m) => (matBySpec[m.规格] = m))

  console.log('='.repeat(66))
  console.log('  V2 测试 · P0 独立复核')
  console.log(`  目标：${BASE}`)
  console.log('='.repeat(66))

  // ============================================================
  // 复核 1：老板提权
  // ============================================================
  console.log('\n【复核 1】老板账号能否把别人提升为管理员（提权）')
  console.log('-'.repeat(66))

  const wz = await call('auth', 'adminLogin', { username: 'wangzong', password: 'wz123456' })
  if (wz.code !== 0) throw new Error(`王总登录失败：${wz.message}`)
  const wzToken = wz.data.token
  console.log(`  王总登录成功，其角色 = ${JSON.stringify(wz.data.user.roles)}`)

  const ul = await call('user', 'list', { keyword: 'AUTOTEST_purchase', pageSize: 5 }, wzToken)
  const target = ((ul.data && ul.data.list) || []).find((u) => u.username === 'AUTOTEST_purchase')
  if (!target) throw new Error('找不到用于复核的 AUTOTEST_purchase 账号')

  const beforeRoles = Array.isArray(target.roles) ? target.roles : []
  const beforeWh = Array.isArray(target.warehouse_ids) ? target.warehouse_ids : []
  console.log(`  目标账号：${target.username}（${target.real_name}）当前角色 = ${JSON.stringify(beforeRoles)}`)

  console.log('  → 王总尝试把它改成 roles=["admin"] …')
  const esc = await call('user', 'updateRole', { id: target._id, roles: ['admin'] }, wzToken)
  console.log(`    请求：user.updateRole  { id: ${target._id}, roles: ["admin"] }`)
  console.log(`    响应：code=${esc.code}  message=${esc.message}`)

  // 验证是否真的生效
  const after = await call('user', 'detail', { id: target._id }, wzToken)
  const nowRoles = (after.data && after.data.roles) || []
  const escalated = nowRoles.includes('admin')

  results.push({
    项: '老板提权为管理员',
    结论: escalated ? '成立（危险）' : '不成立',
    证据: `boss 调 user.updateRole 设 roles=["admin"] → code=${esc.code}；复核后角色=${JSON.stringify(nowRoles)}`
  })
  console.log(`    复核该账号当前角色：${JSON.stringify(nowRoles)}  →  ${escalated ? '⚠️ 提权成功，缺陷成立' : '✅ 未生效'}`)

  // 立刻恢复，绝不留副作用
  const restore = await call(
    'user',
    'updateRole',
    { id: target._id, roles: beforeRoles, warehouse_ids: beforeWh },
    wzToken
  )
  const recheck = await call('user', 'detail', { id: target._id }, wzToken)
  console.log(`  → 已恢复原角色：code=${restore.code}；复核后 = ${JSON.stringify((recheck.data && recheck.data.roles) || [])}`)

  // ============================================================
  // 复核 2：消息投递
  // ============================================================
  console.log('\n【复核 2】消息中心：功能坏了，还是测试账号没有 openid？')
  console.log('-'.repeat(66))

  const devOut = await call('auth', 'login', { dev_openid: 'dev_out' })
  const devSk = await call('auth', 'login', { dev_openid: 'dev_sk' })
  if (devOut.code !== 0 || devSk.code !== 0) throw new Error('dev 账号登录失败')
  console.log(`  dev_out（有 openid）角色 = ${JSON.stringify(devOut.data.roles)}`)
  console.log(`  dev_sk （有 openid）角色 = ${JSON.stringify(devSk.data.roles)}`)

  const beforeUnread = await call('message', 'unreadCount', {}, devOut.data.token)
  console.log(`  dev_out 操作前未读数：${beforeUnread.data && beforeUnread.data.unread}`)

  const spk = matBySpec['TEST-SPK-A']
  console.log('  → dev_out 提交一张领料单（走真实流程）…')
  const sub = await call(
    'outbound',
    'submit',
    {
      warehouse_id: 1,
      type: 'lingyong',
      remark: '[RECHECK] 消息投递验证，测试后清理',
      items: [
        {
          material_id: spk._id,
          material_name: spk.名称,
          material_spec: spk.规格,
          unit: '个',
          quantity: 2
        }
      ]
    },
    devOut.data.token
  )
  console.log(`    提交：code=${sub.code}  单号=${sub.data && sub.data.order_no}  状态=${sub.data && sub.data.status}`)

  console.log('  → dev_sk 确认 + 拣货完成（这两个动作会给领料员发通知）…')
  const c1 = await call('outbound', 'confirm', { id: sub.data._id }, devSk.data.token)
  const c2 = await call('outbound', 'pickDone', { id: sub.data._id }, devSk.data.token)
  console.log(`    确认：code=${c1.code}  ${c1.message}`)
  console.log(`    拣货：code=${c2.code}  ${c2.message}`)
  console.log(`    ★ 拣货接口的提示语声称：${JSON.stringify(c2.message)}`)

  const afterUnread = await call('message', 'unreadCount', {}, devOut.data.token)
  const inbox = await call('message', 'list', { page: 1, pageSize: 10 }, devOut.data.token)
  const msgs = (inbox.data && inbox.data.list) || []

  console.log(`  → dev_out 操作后未读数：${afterUnread.data && afterUnread.data.unread}`)
  console.log(`  → dev_out 收件箱共 ${msgs.length} 条：`)
  msgs.slice(0, 3).forEach((m) => console.log(`      · [${m.type}] ${m.title} — ${m.content}`))

  // 对照：张三（无 openid）
  const zs = await call('auth', 'adminLogin', { username: 'zhangshan', password: 'zs123456' })
  const zsUnread = await call('message', 'unreadCount', {}, zs.data.token)
  const zsInbox = await call('message', 'list', { page: 1, pageSize: 10 }, zs.data.token)
  console.log(
    `  对照（张三，账号密码登录、openid 为空）未读 = ${zsUnread.data && zsUnread.data.unread}，收件箱 = ${(
      (zsInbox.data && zsInbox.data.list) || []
    ).length} 条`
  )

  const delivered = msgs.length > 0
  results.push({
    项: '消息中心是否可用',
    结论: delivered ? '功能正常，Agent 报的是环境假问题' : '功能确实异常',
    证据: `有 openid 的 dev_out 收到 ${msgs.length} 条消息；无 openid 的 zhangshan 收到 ${(
      (zsInbox.data && zsInbox.data.list) || []
    ).length} 条`
  })

  // ============================================================
  console.log('\n' + '='.repeat(66))
  console.log('  复核结论')
  console.log('='.repeat(66))
  results.forEach((r) => {
    console.log(`\n  【${r.项}】${r.结论}`)
    console.log(`    证据：${r.证据}`)
  })

  fs.writeFileSync(
    path.join(__dirname, 'v2-p0-recheck-result.json'),
    JSON.stringify({ 时间: new Date().toISOString(), 结果: results }, null, 2),
    'utf8'
  )
  console.log('\n  复核结果已写入 tests/v2-p0-recheck-result.json')
  console.log('  ⚠️ 本次复核生成的出库单（[RECHECK] 标记）需在 cleanup 阶段清理\n')
}

main().catch((e) => {
  console.error('\n[复核失败]', e.message)
  process.exit(1)
})
