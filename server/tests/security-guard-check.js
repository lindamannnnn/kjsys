/**
 * 安全闸门回归测试（2026-10-12）
 * ============================================================
 * 目的：**锁死「生产环境不可能误删数据」这条底线**，防止将来有人把闸门改坏/绕过。
 *
 * 覆盖：
 *   1. 破坏性 SQL 识别规则（命中 + 不误伤 + 防注释绕过）
 *   2. checkDestructive 三场景（本机放行 / 本机未开启拦截 / 生产硬拦）
 *   3. 【端到端】生产环境下真发一条硬删除 → 必须在触达数据库前被拦下并抛错
 *   4. 静态：连接池 query/execute 仍然挂着闸门（防被删）
 *   5. 静态：全仓扫描 —— 有脚本用 `pool.query()` 直发破坏性 SQL 绕过闸门即报错
 *
 * 用法：node tests/security-guard-check.js
 * ============================================================
 */
require('../src/config/env')

const fs = require('fs')
const path = require('path')

const guard = require('../src/db/destructive-guard')
const { execute, pool } = require('../src/db/pool')

const SERVER = path.resolve(__dirname, '..')
const ROOT = path.resolve(SERVER, '..')

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, detail ? `→ ${detail}` : '') }
}

/** 复刻 pool.js 里的识别规则（正则一致性由「静态」用例保证） */
function looksDestructive(sql) {
  const body = String(sql).replace(/^(\s|\/\*[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)+/, '')
  return /(^|[\s;(])(DELETE\s+FROM|TRUNCATE\b|DROP\s+(TABLE|DATABASE|SCHEMA))/i.test(body)
}

async function main() {
  // ---------- 1. 识别规则 ----------
  console.log('\n1. 破坏性 SQL 识别规则')
  check('命中 DELETE FROM', looksDestructive('DELETE FROM materials WHERE id = 1'))
  check('命中 TRUNCATE', looksDestructive('TRUNCATE TABLE stock_logs'))
  check('命中 DROP TABLE', looksDestructive('DROP TABLE `users`'))
  check('命中 DROP DATABASE', looksDestructive('DROP DATABASE shenglong'))
  check('命中前导块注释绕过', looksDestructive('/* note */ DELETE FROM x'))
  check('命中 -- 注释绕过', looksDestructive('-- note\nDELETE FROM x'))
  check('不误伤 SELECT', !looksDestructive('SELECT * FROM materials WHERE is_deleted = 0'))
  check('不误伤 INSERT（含 delete 字样）', !looksDestructive("INSERT INTO x (a) VALUES ('delete from here')"))
  check('不误伤 UPDATE（业务软删）', !looksDestructive('UPDATE materials SET is_deleted = 1 WHERE id = 1'))

  // ---------- 2. 三场景判定 ----------
  console.log('\n2. 闸门判定（三场景）')
  const savedEnv = { NODE_ENV: process.env.NODE_ENV, ALLOW_DESTRUCTIVE: process.env.ALLOW_DESTRUCTIVE }
  try {
    process.env.NODE_ENV = 'development'; process.env.ALLOW_DESTRUCTIVE = '1'
    check('本机开发 + 显式开启 → 放行', guard.checkDestructive('t').ok === true)

    process.env.NODE_ENV = 'development'; process.env.ALLOW_DESTRUCTIVE = '0'
    check('本机开发 + 未开启 → 拦截', guard.checkDestructive('t').ok === false)

    process.env.NODE_ENV = 'development'; delete process.env.ALLOW_DESTRUCTIVE
    check('本机开发 + 开关缺失 → 拦截', guard.checkDestructive('t').ok === false)

    process.env.NODE_ENV = 'production'; process.env.ALLOW_DESTRUCTIVE = '1'
    check('生产 + 显式开启 → 仍硬拦（无绕过）', guard.checkDestructive('t').ok === false)

    process.env.NODE_ENV = 'production'; process.env.ALLOW_DESTRUCTIVE = '0'
    check('生产 + 未开启 → 拦截', guard.checkDestructive('t').ok === false)

    // ---------- 3. 端到端 ----------
    console.log('\n3. 端到端拦截（真发 SQL，应在触达数据库前被拦）')
    process.env.NODE_ENV = 'production'; process.env.ALLOW_DESTRUCTIVE = '1'
    let caught = null
    try {
      // id = -1 永远不存在：万一闸门失效也只是删不到东西，不会污染真实数据
      await execute('DELETE FROM materials WHERE id = -1')
    } catch (e) {
      caught = e
    }
    check('生产环境发 DELETE 被拦截并抛错', !!caught && /安全闸门/.test(String(caught.message)),
      caught ? String(caught.message).split('\n')[0] : '竟然没抛错——闸门失效！')

    process.env.NODE_ENV = 'development'; process.env.ALLOW_DESTRUCTIVE = '1'
    let okRun = true
    try {
      await execute('DELETE FROM materials WHERE id = -1')
    } catch (e) {
      okRun = false
    }
    check('本机开发环境放行（不误伤）', okRun)
  } finally {
    if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv.NODE_ENV
    if (savedEnv.ALLOW_DESTRUCTIVE === undefined) delete process.env.ALLOW_DESTRUCTIVE; else process.env.ALLOW_DESTRUCTIVE = savedEnv.ALLOW_DESTRUCTIVE
  }
  await pool.end()

  // ---------- 4. 静态：连接池闸门仍在 ----------
  console.log('\n4. 静态检查：连接池闸门未被移除')
  const poolSrc = fs.readFileSync(path.join(SERVER, 'src/db/pool.js'), 'utf8')
  check('pool.js 定义 assertNotDestructive', /function\s+assertNotDestructive/.test(poolSrc))
  check('query() 挂了闸门', /async function query[\s\S]{0,200}assertNotDestructive\(sql\)/.test(poolSrc))
  check('execute() 挂了闸门', /async function execute[\s\S]{0,200}assertNotDestructive\(sql\)/.test(poolSrc))

  // ---------- 5. 静态：扫描绕过点 ----------
  console.log('\n5. 静态扫描：破坏性 SQL 与绕过点')
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-local', 'results', 'backups', 'uploads'])
  const DESTRUCTIVE = /DELETE\s+FROM|TRUNCATE\b|DROP\s+(TABLE|DATABASE|SCHEMA)/i
  const selfName = path.basename(__filename)
  const guarded = []
  const bypass = []

  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(full); continue }
      if (!ent.name.endsWith('.js')) continue
      if (ent.name === selfName || ent.name === '_probe-guard-one.js') continue
      const src = fs.readFileSync(full, 'utf8')
      if (!DESTRUCTIVE.test(src)) continue
      const rel = path.relative(ROOT, full).replace(/\\/g, '/')
      if (/pool\.query\(/.test(src)) bypass.push(rel)
      else guarded.push(rel)
    }
  }
  walk(path.join(SERVER, 'tests'))
  walk(path.join(SERVER, 'scripts'))
  walk(path.join(SERVER, 'src'))

  check('没有脚本用 pool.query() 直发破坏性 SQL 绕过闸门', bypass.length === 0, bypass.join('、'))
  console.log(`     （含破坏性 SQL 且走 execute/query 的脚本 ${guarded.length} 个，均被池级闸门覆盖）`)
  console.log(`      ${guarded.map((f) => path.basename(f)).join(', ')}`)

  console.log(`\n──────── 结果：通过 ${pass} / 失败 ${fail} ────────`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
