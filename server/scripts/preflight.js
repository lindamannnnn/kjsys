#!/usr/bin/env node
'use strict'
/**
 * 上线前闸门（preflight）
 * ============================================================
 * 一条命令，把「上线前必须为真的三件事」全部跑一遍：
 *   ① 身份口径 lint      代码里是否用「openid 有无」筛人
 *   ② 结构漂移           schema.sql ⇄ 目标库
 *   ③ 代码列引用         代码实写的「表.列」 ⇄ 目标库
 *
 * 为什么需要它（2026-10-16 生产实操事故）：
 *   上线后真点才暴露 3 个缺陷，全都是「代码 / 库」不一致类：
 *     · 采购录价 500    → 库缺 channel_remark 列（schema.sql 也缺，漂移检测看不见）
 *     · 消息已读必 401   → 用 openid 当身份，而后台账号没有 openid
 *     · 采购指派下拉空   → 同上，SQL 里把「openid 非空」当成人条件
 *   这 3 个**单元测试、接口冒烟、dev 库一个都抓不到**
 *   （dev 库是自己建的：结构最新、账号齐备、openid 齐全）。
 *
 *   唯一可靠的姿势：拿「即将上线的这份代码」去对「目标库」做静态 + 结构对撞。
 *
 * 用法：
 *   cd server && npm run preflight
 *   # 上生产前，先开隧道连生产库，再用环境变量指过去：
 *   DB_HOST=127.0.0.1 DB_PORT=13306 DB_USER=xxx DB_PASSWORD=xxx DB_NAME=shenglong \
 *     npm run preflight
 *   npm run preflight -- --json     # 结构化输出（便于存档 / 挂 CI）
 *
 * 退出码：0 = 全绿，可以上线；1 = 有阻塞项，**不要上线**；2 = 闸门自身故障
 * ============================================================
 */
const drift = require('./check-schema-drift')
const codeSchema = require('./check-code-schema')
const identity = require('./lint-identity')
const { pool } = require('../src/db/pool')

const BAR = '='.repeat(64)

function shorten(arr, n = 12) {
  return arr.slice(0, n)
}

/** 把各种形态的「一条问题」统一成一行可读文本（避免打印出 [object Object]） */
function fmtErr(e) {
  if (typeof e === 'string') return e.replace(/\n/g, '\n        ')
  if (e && e.file) return `[${e.id}] ${e.file}:${e.line}  ${e.snippet || ''}`
  return JSON.stringify(e)
}

async function runCheck(id, name, fn) {
  try {
    const r = await fn()
    return { id, name, ...r }
  } catch (e) {
    return { id, name, status: 'ERROR', message: (e && e.message) || String(e) }
  }
}

async function main() {
  const asJson = process.argv.includes('--json')

  // ---------- 目标库 ----------
  let dbName = null
  let dbErr = null
  try {
    const [rows] = await pool.query('SELECT DATABASE() AS d')
    dbName = rows[0].d
  } catch (e) {
    dbErr = (e && e.message) || String(e)
  }

  // ---------- ① 身份口径 lint（纯静态，不依赖库） ----------
  const s1 = await runCheck('identity', '身份口径 lint（禁止用 openid 有无筛人）', async () => {
    const r = identity.lint()
    return {
      status: r.errors.length ? 'FAIL' : 'PASS',
      errors: r.errors,
      warns: r.warns,
      waived: r.waived,
      extra: `${r.scanned} 文件${r.waived.length ? ` / 豁免 ${r.waived.length}` : ''}`
    }
  })

  // ---------- ② 结构漂移 ----------
  const s2 = dbName
    ? await runCheck('drift', '结构漂移（schema.sql ⇄ 库）', async () => {
        const r = await drift.run()
        return { status: r.errors.length ? 'FAIL' : 'PASS', errors: r.errors, notes: r.notes, extra: `${r.schemaTables} 表` }
      })
    : { id: 'drift', name: '结构漂移（schema.sql ⇄ 库）', status: 'SKIP', message: `数据库连不上：${dbErr}` }

  // ---------- ③ 代码列引用 ----------
  const s3 = dbName
    ? await runCheck('code-schema', '代码列引用（代码实写的列 ⇄ 库）', async () => {
        const r = await codeSchema.run()
        const errs = [
          ...r.missingTable.map((x) => `库中无此表：${x}`),
          ...r.exact.map((e) => `库缺列 ${e.table}.${e.col}  ← ${e.where}`)
        ]
        return { status: errs.length ? 'FAIL' : 'PASS', errors: errs, suspicious: r.suspicious, extra: `${r.scannedFiles} 文件 / ${r.refs} 处引用` }
      })
    : { id: 'code-schema', name: '代码列引用（代码实写的列 ⇄ 库）', status: 'SKIP', message: `数据库连不上：${dbErr}` }

  const steps = [s1, s2, s3]

  // ---------- 汇总 ----------
  const failed = steps.filter((s) => s.status === 'FAIL')
  const errored = steps.filter((s) => s.status === 'ERROR')
  const skipped = steps.filter((s) => s.status === 'SKIP')

  if (asJson) {
    console.log(
      JSON.stringify(
        { at: new Date().toISOString(), db: dbName, ok: !failed.length && !errored.length && !skipped.length, steps },
        null,
        2
      )
    )
    await pool.end()
    process.exit(failed.length || errored.length || skipped.length ? 1 : 0)
  }

  console.log(BAR)
  console.log('  上线前闸门  preflight')
  console.log(`  时间：${new Date().toLocaleString('zh-CN')}`)
  console.log(`  目标库：${dbName || `❌ 连不上（${dbErr}）`}`)
  console.log(BAR)
  console.log('')

  for (const s of steps) {
    const icon = s.status === 'PASS' ? '✅' : s.status === 'FAIL' ? '❌' : s.status === 'SKIP' ? '⏭️ ' : '💥'
    console.log(`${icon} ${s.name}  →  ${s.status}${s.extra ? `  （${s.extra}）` : ''}`)

    if (s.message) console.log(`     ${s.message}`)

    if (s.errors && s.errors.length) {
      shorten(s.errors).forEach((e, i) => console.log(`     ${i + 1}. ${fmtErr(e)}`))
      if (s.errors.length > 12) console.log(`     …… 其余 ${s.errors.length - 12} 项省略`)
    }

    if (s.waived && s.waived.length) {
      console.log(`     ℹ️  显式豁免 ${s.waived.length} 处（已知设计，理由可审阅）：`)
      s.waived.forEach((w) => console.log(`        · ${w.file}:${w.line}  ${w.reason || ''}`))
    }

    if (s.warns && s.warns.length) {
      console.log(`     ⚠️  另有 ${s.warns.length} 处需人工确认（不阻塞）：`)
      s.warns.slice(0, 5).forEach((w) => console.log(`        · ${w.file}:${w.line}  ${w.snippet || ''}`))
    }

    if (s.suspicious && s.suspicious.length) {
      console.log(`     ⚠️  另有 ${s.suspicious.length} 处可疑列引用（不阻塞，建议瞄一眼）：`)
      s.suspicious.slice(0, 5).forEach((x) => console.log(`        · ${x.table}.${x.col}  ${x.where}`))
    }

    if (s.notes && s.notes.length) {
      console.log(`     ℹ️  ${s.notes.length} 处提示（不阻塞）`)
    }
    console.log('')
  }

  console.log(BAR)
  if (!failed.length && !errored.length && !skipped.length) {
    console.log('  ✅ 全绿 —— 结构与身份口径都与这份代码一致，可以上线')
  } else {
    if (failed.length) {
      console.log(`  ❌ ${failed.length} 项未通过 —— 不要上线，先修完再跑一次`)
    }
    if (skipped.length) {
      console.log(`  ⏭️  ${skipped.length} 项被跳过（库连不上）—— 结论不完整，不算通过`)
    }
    if (errored.length) {
      console.log(`  💥 ${errored.length} 项闸门自身故障 —— 请先修闸门`)
    }
  }
  console.log(BAR)

  await pool.end()
  process.exit(failed.length || errored.length || skipped.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error('\n❌ preflight 自身失败：', (e && e.stack) || e)
  try {
    await pool.end()
  } catch (_) {
    /* 忽略 */
  }
  process.exit(2)
})
