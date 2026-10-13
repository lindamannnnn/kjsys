/**
 * 后端接口覆盖审计
 * ------------------------------------------------------------
 * 1. 从 server/src/modules/*.js 加载每个模块，取出真实的 actions 清单
 * 2. 从 server/tests/*.js 与 scripts/ui-*.js 里扫出所有被调用过的 module.action
 * 3. 输出差集：从未被任何测试触碰过的接口
 *
 * 用法：node scripts/audit-api-coverage.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const MODULES_DIR = path.join(ROOT, 'server', 'src', 'modules')
const TESTS_DIR = path.join(ROOT, 'server', 'tests')
const SCRIPTS_DIR = path.join(ROOT, 'scripts')

// ---------- 1. 收集所有真实接口 ----------
const allApis = []       // { route: 'module.action', public: bool, roles: [...] }
const moduleFiles = fs.readdirSync(MODULES_DIR).filter((f) => f.endsWith('.js'))

for (const file of moduleFiles) {
  let mod
  try {
    mod = require(path.join(MODULES_DIR, file))
  } catch (e) {
    console.log(`[跳过] ${file} 加载失败：${e.message}`)
    continue
  }
  const name = mod.name || path.basename(file, '.js')
  const actions = mod.actions || {}
  const publicActions = mod.publicActions || []
  const roleRules = mod.roleRules || {}

  for (const action of Object.keys(actions)) {
    allApis.push({
      route: `${name}.${action}`,
      module: name,
      action,
      public: publicActions.includes(action),
      roles: roleRules[action] || null
    })
  }
}

// ---------- 2. 扫出测试里调用过的接口 ----------
const callSites = new Set()
// 三种调用写法都要认：
//   1) call('material', 'list')      —— 本项目测试脚本主用法（两个独立字符串）
//   2) call('material.list')         —— 点号合并写法
//   3) '/api/material/list'          —— 直写 URL
const PAIR_RE = /['"`]([a-z]+)['"`]\s*,\s*['"`]([a-zA-Z][a-zA-Z0-9_]*)['"`]/g
const STR_RE = /['"`]([a-z]+)\.([a-zA-Z][a-zA-Z0-9_]*)['"`]/g

const scannedFiles = []
for (const dir of [TESTS_DIR, SCRIPTS_DIR]) {
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(js|mjs)$/.test(f)) continue
    scannedFiles.push(path.join(dir, f))
  }
}

const moduleNames = new Set(allApis.map((a) => a.module))
for (const file of scannedFiles) {
  const src = fs.readFileSync(file, 'utf8')
  let m
  PAIR_RE.lastIndex = 0
  while ((m = PAIR_RE.exec(src)) !== null) {
    if (moduleNames.has(m[1])) callSites.add(`${m[1]}.${m[2]}`)
  }
  STR_RE.lastIndex = 0
  while ((m = STR_RE.exec(src)) !== null) {
    if (moduleNames.has(m[1])) callSites.add(`${m[1]}.${m[2]}`)
  }
  // 也扫 url: '/api/xxx/yyy' 形式
  const urlRe = /\/api\/([a-z]+)\/([a-zA-Z0-9_]+)/g
  while ((m = urlRe.exec(src)) !== null) {
    if (moduleNames.has(m[1])) callSites.add(`${m[1]}.${m[2]}`)
  }
}

// ---------- 3. 差集 ----------
const covered = []
const uncovered = []
for (const api of allApis) {
  if (callSites.has(api.route)) covered.push(api)
  else uncovered.push(api)
}

// ---------- 4. 输出 ----------
console.log('='.repeat(64))
console.log('后端接口覆盖审计')
console.log('='.repeat(64))
console.log(`扫描测试文件：${scannedFiles.length} 个`)
console.log(`后端接口总数：${allApis.length}`)
console.log(`已被测试触达：${covered.length}`)
console.log(`从未被测试  ：${uncovered.length}`)
console.log('')

const byModule = {}
for (const api of uncovered) {
  ;(byModule[api.module] = byModule[api.module] || []).push(api)
}
for (const [mod, list] of Object.entries(byModule)) {
  console.log(`── ${mod}（${list.length} 个未覆盖）`)
  for (const a of list) {
    const tag = a.public ? '公开' : '需登录'
    const role = a.roles ? ` 角色=${JSON.stringify(a.roles)}` : ''
    console.log(`   · ${a.action}   [${tag}]${role}`)
  }
  console.log('')
}

// 落盘 JSON 供后续补测使用
const outPath = path.join(ROOT, '.tmp-local-audit', 'api-coverage.json')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify({ allApis, covered, uncovered }, null, 2), 'utf8')
console.log(`明细已落盘：${outPath}`)
