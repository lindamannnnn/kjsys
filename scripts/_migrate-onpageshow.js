/**
 * 一次性迁移脚本：把 16 个页面的 onShow 注册方式换成不依赖 vendor 导出的写法
 *   - 去掉 vue import 里的 getCurrentInstance（新方案不用它）
 *   - 删掉 `onShow(__pageShowHandler, getCurrentInstance())` 这一行
 *   - 把 `onMounted(__pageShowHandler)` 改成在 mounted 里「首屏跑一次 + 注册钩子」
 * 串行改写，逐文件校验替换次数，任何一处不匹配就报错退出。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram', 'src', 'pages')

const FILES = [
  'index/index.vue',
  'boss/dashboard.vue',
  'boss/orders.vue',
  'boss/stock.vue',
  'boss/trend.vue',
  'boss/warning.vue',
  'check/list.vue',
  'in/history.vue',
  'out/history.vue',
  'my/profile.vue',
  'purchase/history.vue',
  'purchase/ledger.vue',
  'storekeeper/dashboard.vue',
  'storekeeper/orders.vue',
  'storekeeper/pending.vue',
  'storekeeper/stock.vue'
]

let failed = 0
const report = []

for (const rel of FILES) {
  const file = path.join(ROOT, rel)
  let src = fs.readFileSync(file, 'utf8')
  const before = src
  const notes = []

  // 1) 去掉 vue import 中的 getCurrentInstance
  const vueImportRe = /(import\s*\{)([^}]*)(\}\s*from\s*['"]vue['"])/
  const vm = src.match(vueImportRe)
  if (vm && /getCurrentInstance/.test(vm[2])) {
    const cleaned = vm[2]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'getCurrentInstance')
      .join(', ')
    src = src.replace(vueImportRe, `$1 ${cleaned} $3`)
    notes.push('vue import 去掉 getCurrentInstance')
  } else {
    notes.push('!! vue import 未匹配到 getCurrentInstance')
  }

  // 2) 删掉 onShow(handler, getCurrentInstance()) 这一行
  const showCallRe = /^[ \t]*onShow\(\s*(__[A-Za-z0-9_]+)\s*,\s*getCurrentInstance\(\)\s*\)[ \t]*\r?\n/gm
  const showMatches = src.match(showCallRe)
  if (showMatches && showMatches.length === 1) {
    src = src.replace(showCallRe, '')
    notes.push('删除 onShow(..., getCurrentInstance())')
  } else {
    notes.push(`!! onShow 调用匹配数 = ${showMatches ? showMatches.length : 0}`)
  }

  // 3) onMounted(handler) → onMounted(() => { handler(); onShow(handler) })
  const mountedRe = /^([ \t]*)onMounted\(\s*(__[A-Za-z0-9_]+)\s*\)[ \t]*$/gm
  const mountedMatches = [...src.matchAll(mountedRe)]
  if (mountedMatches.length === 1) {
    const indent = mountedMatches[0][1]
    const handler = mountedMatches[0][2]
    src = src.replace(
      mountedRe,
      `${indent}onMounted(() => {\n` +
        `${indent}  ${handler}()      // 首屏一定加载（onMounted 兜底，不依赖任何注册成功与否）\n` +
        `${indent}  onShow(${handler})  // 之后每次页面重新显示（含从子页返回）都刷新\n` +
        `${indent}})`
    )
    notes.push('onMounted 改为「首屏加载 + 注册显示钩子」')
  } else {
    notes.push(`!! onMounted(handler) 匹配数 = ${mountedMatches.length}`)
  }

  if (src === before) {
    notes.push('!! 文件未被改动')
  }

  const bad = notes.some((n) => n.startsWith('!!'))
  if (bad) failed++
  else fs.writeFileSync(file, src, 'utf8')

  report.push(`${bad ? 'FAIL' : ' ok '}  ${rel}  |  ${notes.join(' / ')}`)
}

console.log(report.join('\n'))
console.log(`\n合计 ${FILES.length} 个文件，失败 ${failed} 个`)
process.exit(failed ? 1 : 0)
