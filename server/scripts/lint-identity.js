#!/usr/bin/env node
'use strict'
/**
 * 身份口径 lint（防回归护栏）
 * ============================================================
 * 背景（2026-10-16 生产事故链）：
 *   本系统的「操作者身份」有两个来源：
 *     · 小程序用户 → 微信 openid
 *     · 后台手工建的账号 → **没有 openid**，只有 username
 *   统一口径 = `identityOf(user) = user.openid || user.username`
 *
 *   一旦某处 SQL 用「openid 是否为空」来筛人，后台账号就会被**整批静默排除**：
 *     · 消息已读        → 必然 401
 *     · 采购指派下拉    → 永远是空的
 *     · 盘点人员候选    → 只剩有 openid 的那 1 个人（生产实测 6 人里 5 人无 openid）
 *   这类 bug 单元测试、dev 库都发现不了（dev 库账号恰好都有 openid），
 *   只有拿生产账号真点才会暴露 → 所以必须做成静态护栏。
 *
 * 判据：
 *   🔥 错误：裸 `openid`（前面不带下划线前缀）参与 NULL / 空串比较
 *          → 100% 是在「用 openid 有无来筛人」，必然漏掉后台账号
 *   ⚠️ 提示：裸 `openid = ?` 出现在非白名单文件里（可能按身份过滤业务数据）
 *
 * 不报（安全）：
 *   · `xxx_openid`（operator_openid / to_openid / taker_openid …）—— 历史列名，
 *     值本身存的就是 identityOf 的结果，按它过滤是正确的
 *   · 白名单文件（登录、迁移脚本）
 *
 * 用法：cd server && node scripts/lint-identity.js
 * 退出码：0=通过；1=有违规
 * ============================================================
 */
const fs = require('fs')
const path = require('path')

const SRC_DIR = path.join(__dirname, '..', 'src')

/** 白名单：这些文件里裸 openid 是合法的（登录本身就要用 openid 找人） */
const ALLOW_FILES = [
  'modules/auth.js', // 微信登录：靠 openid 找用户
  'services/wechat.js', // 微信服务
  'services/wecom.js', // 企微服务
  'db/' // 迁移 / seed 脚本
]

function walkJs(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walkJs(p, out)
    else if (f.endsWith('.js')) out.push(p)
  }
  return out
}

/**
 * 去掉注释，避免「注释里举反例」被误报。
 * ⚠️ 必须保持**行数不变**，否则报出来的行号与实际代码对不上（踩过一次）。
 *    所以块注释只把非换行字符换成空格，不删行。
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 🔥 核心判据：裸 openid 参与 NULL / 空串比较
 *    (?<![_\w]) 保证前面不是 `_`，从而放过 operator_openid / to_openid 这类列名
 */
const RE_BARE_NULL = /(?<![_\w])openid\s*(?:IS\s+NOT\s+NULL|IS\s+NULL|<>|!=)\s*(?:''|""|NULL)?/gi

/** ⚠️ 次要判据：裸 openid = ? （在非白名单文件里可疑） */
const RE_BARE_EQ = /(?<![_\w])openid\s*=\s*\?/gi

function isAllowed(rel) {
  return ALLOW_FILES.some((a) => rel.startsWith(a))
}

/**
 * 显式豁免：允许某一行「明知故犯」，但必须写明理由，且要留下痕迹。
 * 写法（该行或上一行）：  // preflight-allow: BARE-OPENID-NULL — 理由
 * 注意：豁免检测必须用**未去注释**的原文，因为豁免标记本身就在注释里。
 *
 * ⚠️ 豁免**必须在输出里可见**（含理由）。否则「豁免」就等于静默消音，
 *    而静默消音正是让缺陷藏起来的标准手法 —— 那就白做这道闸门了。
 *
 * 返回：{ waived, reason }
 */
function waiverOf(rawLines, idx, ruleId) {
  const mk = new RegExp(`preflight-allow:\\s*${ruleId}`)
  for (const line of [rawLines[idx] || '', rawLines[idx - 1] || '']) {
    const at = mk.exec(line)
    if (at) {
      const reason = line
        .slice(at.index + at[0].length)
        .replace(/^[\s—–\-*\/]+/, '') // 去掉分隔符与注释尾巴
        .trim()
      return { waived: true, reason: reason || '(未写理由)' }
    }
  }
  return { waived: false, reason: '' }
}

function lint() {
  const files = walkJs(SRC_DIR)
  const errors = []
  const warns = []
  const waived = []

  for (const f of files) {
    const rel = f.replace(/\\/g, '/').split('/server/src/')[1] || f
    const raw = fs.readFileSync(f, 'utf8')
    const rawLines = raw.split('\n') // 保留注释：豁免标记藏在这里
    const lines = stripComments(raw).split('\n') // 行号与 rawLines 对齐

    lines.forEach((line, i) => {
      const lineNo = i + 1
      const snippet = line.trim().slice(0, 120)

      // 🔥 裸 openid 与 NULL / 空串比较 —— 任何文件都报（包括白名单，
      //    因为连 auth 里也不该用「openid 非空」来筛人）
      RE_BARE_NULL.lastIndex = 0
      if (RE_BARE_NULL.test(line)) {
        const w = waiverOf(rawLines, i, 'BARE-OPENID-NULL')
        if (w.waived) {
          waived.push({ file: rel, line: lineNo, snippet, id: 'BARE-OPENID-NULL', reason: w.reason })
        } else {
          errors.push({ file: rel, line: lineNo, snippet, id: 'BARE-OPENID-NULL' })
        }
      }

      // ⚠️ 裸 openid = ? —— 白名单内放行
      RE_BARE_EQ.lastIndex = 0
      if (!isAllowed(rel) && RE_BARE_EQ.test(line)) {
        warns.push({ file: rel, line: lineNo, snippet, id: 'BARE-OPENID-EQ' })
      }
    })
  }

  return { scanned: files.length, errors, warns, waived }
}

async function main() {
  const r = lint()
  console.log('==================================================')
  console.log('  身份口径 lint：禁止用「openid 有无」来筛人')
  console.log(`  扫描：${r.scanned} 个源文件 · 白名单：${ALLOW_FILES.join(', ')}`)
  console.log('==================================================\n')

  if (r.errors.length) {
    console.log(`🔥 违规 ${r.errors.length} 处（会让后台账号被整批排除）：\n`)
    r.errors.forEach((e, i) => {
      console.log(`  ${i + 1}. [${e.id}] ${e.file}:${e.line}`)
      console.log(`     ${e.snippet}`)
    })
    console.log('')
    console.log('  正确写法：统一用 identityOf(ctx.user)（= openid || username），')
    console.log('  或写成 (openid = ? OR username = ?) 两边都匹配。\n')
  } else {
    console.log('✅ 没有发现「用 openid 有无筛人」的写法\n')
  }

  // 豁免项必须可见（含理由）—— 否则闸门等于被静默关掉
  if (r.waived.length) {
    console.log(`ℹ️  显式豁免 ${r.waived.length} 处（**已知设计**，非缺陷；理由必须可审阅）：`)
    r.waived.forEach((w) => {
      console.log(`     · ${w.file}:${w.line}  [${w.id}]`)
      console.log(`       理由：${w.reason}`)
    })
    console.log('')
  }

  if (r.warns.length) {
    console.log(`⚠️  需人工确认 ${r.warns.length} 处（裸 openid = ?，非白名单文件）：`)
    r.warns.forEach((w) => console.log(`     · ${w.file}:${w.line}  ${w.snippet}`))
    console.log('')
  }

  process.exit(r.errors.length ? 1 : 0)
}

module.exports = { lint }

if (require.main === module) {
  main().catch((e) => {
    console.error('lint 自身失败：', e)
    process.exit(2)
  })
}
