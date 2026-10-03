/**
 * ============================================================
 * 迁移：把「入库员 in」并入「仓管员 storekeeper」
 * ------------------------------------------------------------
 * 背景（流程重构 V2 · 2026-10-03）：
 *   入库归仓管员负责，原 'in' 角色取消。
 *   代码侧已同步移除：user.js 的 VALID_ROLES、inbound.js 的 roleRules、
 *   stats.js 的两个只读动作、admin 的角色常量、小程序的角色入口。
 *
 *   但历史数据里 users.roles 数组仍可能含 'in'——不迁移的话，
 *   这些账号登录后权限判定全部落空，会「什么入口都看不到」。
 *
 * 做什么：
 *   遍历 users，把 roles 里的 'in' 替换为 'storekeeper' 并去重。
 *   顺带报告已废弃的 dev_in 账号（只报告，不自动删）。
 *
 * 用法：
 *   node src/db/migrate-merge-in-role.js           # 预演，不写库（默认）
 *   node src/db/migrate-merge-in-role.js --apply   # 真正执行
 *
 * 安全性：默认 dry-run；只改 roles 一列，不触碰其它字段；
 *         不删除任何账号。
 * ============================================================
 */
require('../config/env')

const { pool, query, execute } = require('./pool')

const APPLY = process.argv.includes('--apply')
const OLD_ROLE = 'in'
const NEW_ROLE = 'storekeeper'

/** roles 列可能是 JSON 字符串，也可能已被驱动解析为数组，两种都要兜住 */
function parseRoles(raw) {
  if (Array.isArray(raw)) return raw
  if (raw == null) return []
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? v : []
    } catch (e) {
      return []
    }
  }
  return []
}

/** 把 'in' 换成 'storekeeper'，去重且保持原有顺序 */
function normalizeRoles(list) {
  const out = []
  for (const r of list) {
    const v = r === OLD_ROLE ? NEW_ROLE : r
    if (v && out.indexOf(v) === -1) out.push(v)
  }
  return out
}

async function main() {
  console.log('==============================================')
  console.log('  迁移：入库员 in → 仓管员 storekeeper')
  console.log(`  模式：${APPLY ? '★ 实际执行（会写库）' : '预演（不写库）'}`)
  console.log('==============================================')

  // JSON_CONTAINS 是 MySQL 5.7+ 的 JSON 函数；roles 列本身就是 JSON 类型，能直接用
  const rows = await query(
    `SELECT id, openid, username, real_name, roles
       FROM users
      WHERE roles IS NOT NULL
        AND JSON_CONTAINS(roles, JSON_QUOTE(?))`,
    [OLD_ROLE]
  )

  if (!rows.length) {
    console.log('\n没有需要迁移的账号：roles 里已不含 "' + OLD_ROLE + '"。')
  } else {
    console.log(`\n命中 ${rows.length} 个账号：\n`)
    for (const u of rows) {
      const before = parseRoles(u.roles)
      const after = normalizeRoles(before)
      const who = (u.openid || u.username || '').padEnd(16)
      console.log(`  #${u.id} ${who} ${u.real_name || ''}`)
      console.log(`      ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
      if (APPLY) {
        await execute('UPDATE users SET roles = ? WHERE id = ?', [
          JSON.stringify(after),
          u.id
        ])
      }
    }
  }

  // 顺带报告已废弃的开发身份（不自动删，避免误伤真人账号）
  const devs = await query(
    `SELECT id, openid, status FROM users WHERE openid = 'dev_in'`
  )
  if (devs.length) {
    console.log('\n⚠️  发现已废弃的开发身份 dev_in（入库员）：')
    for (const d of devs) {
      console.log(`      #${d.id} dev_in（当前状态 ${d.status}）`)
    }
    console.log('      入库权限已归仓管员，测试请改用 dev_sk；')
    console.log('      确认不再需要后可到管理后台禁用它（本脚本不会自动删账号）。')
  }

  console.log(
    APPLY
      ? '\n✅ 迁移完成。'
      : '\n以上为预演结果，确认无误后加 --apply 真正执行。'
  )

  await pool.end()
}

main().catch(async (err) => {
  console.error('\n❌ 迁移失败：', err && err.message ? err.message : err)
  try {
    await pool.end()
  } catch (e) {
    /* 连接可能已断，忽略 */
  }
  process.exit(1)
})
