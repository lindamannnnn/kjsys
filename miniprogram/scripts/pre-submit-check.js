/**
 * ============================================================
 * 小程序「提交微信审核前」本地自检
 * ------------------------------------------------------------
 * 为什么需要它：下面这些项**接口测试和构建都测不到**，但每一项都会让审核被打回，
 * 或者让"审核能过、用户用不了"：
 *   · appid 三处不一致（开发者工具 / manifest / 服务端）→ 真实微信登录失败
 *   · 接口地址是 http 或内网 IP → 正式版小程序直接请求被拦
 *   · manifest 里残留 permission 声明 → 污染隐私审核
 *   · 用了隐私类 API 但没配《隐私保护指引》→ 审核驳回
 *   · pages.json 注册了不存在的页面 → 打开即报错
 *
 * 本脚本 **只读**，不改任何文件。输出分三档：
 *   [必须修] 会让审核不过或正式版不可用
 *   [要注意] 演示/体验版能用，但上线前必须处理
 *   [信息]   供核对，不一定有问题
 *
 * 用法：
 *   cd miniprogram && node scripts/pre-submit-check.js
 * ============================================================ */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')       // miniprogram/
const REPO = path.resolve(ROOT, '..')            // 仓库根
const rows = []

function rec(level, item, detail) {
  rows.push({ level, item, detail })
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

/** 从 server/.env 里取一个键（不引依赖，只做简单解析） */
function envValue(key) {
  try {
    const txt = fs.readFileSync(path.join(REPO, 'server/.env'), 'utf8')
    const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'))
    return m ? m[1].trim() : ''
  } catch (e) { return '' }
}

// ---------------------------------------------------------------- A. 身份
const projCfg = readJson(path.join(ROOT, 'project.config.json')) || {}
const manifest = readJson(path.join(ROOT, 'src/manifest.json')) || {}
const mpAppid = (manifest['mp-weixin'] && manifest['mp-weixin'].appid) || ''
const projAppid = projCfg.appid || ''
const serverAppid = envValue('WX_APPID')
const serverSecret = envValue('WX_SECRET')
const allowDevLogin = envValue('ALLOW_DEV_LOGIN')

const APPID_RE = /^wx[0-9a-f]{16}$/
rec(APPID_RE.test(projAppid) ? 'info' : 'must',
  'project.config.json 的 appid 格式',
  projAppid + (APPID_RE.test(projAppid) ? '（合法）' : '（不合法，应为 wx + 16 位十六进制）'))

if (projAppid && mpAppid && projAppid !== mpAppid) {
  rec('must', 'appid 一致性（project.config vs manifest）', `不一致：${projAppid} ≠ ${mpAppid}`)
} else {
  rec('info', 'appid 一致性（project.config vs manifest）', `一致：${projAppid}`)
}

if (!serverAppid) {
  rec('must', '服务端 WX_APPID 是否配置', 'server/.env 里为空 → 真实微信登录必然失败')
} else if (serverAppid !== projAppid) {
  rec('must', 'appid 一致性（小程序 vs 服务端）',
    `不一致：小程序 ${projAppid} ≠ 服务端 ${serverAppid} → code2session 会报 40013 invalid appid`)
} else {
  rec('info', 'appid 一致性（小程序 vs 服务端）', `一致：${projAppid}`)
}

if (!serverSecret) {
  rec('note', '服务端 WX_SECRET', '为空 → 无法用 code 换 openid，只能靠开发登录（ALLOW_DEV_LOGIN）')
} else {
  rec('info', '服务端 WX_SECRET', '已配置')
}
if (String(allowDevLogin).toLowerCase() === 'true') {
  rec('note', '服务端 ALLOW_DEV_LOGIN', '为 true（开发登录开着）→ 正式上线前应关闭')
}

// ---------------------------------------------------------------- B. 接口地址
const cloudSrc = fs.readFileSync(path.join(ROOT, 'src/utils/cloud.js'), 'utf8')
// 兼容两种写法：直接赋值 const API_BASE = '...'，或带构建注入回退的
// const API_BASE = (__API_BASE__) ? __API_BASE__ : 'http://...'（回退地址才是判定对象）
const apiMatch = cloudSrc.match(/API_BASE[\s\S]{0,300}?['"](https?:\/\/[^'"]+)['"]/)
const API_BASE = apiMatch ? apiMatch[1] : ''

// DEV_MODE 自 2026-10-01 起改为「编译期注入」（vite define 的 __DEV_LOGIN__），
// 源码里已经没有字面量 true/false 了，所以判定必须以**构建产物**为准。
const distCloudPath = path.join(ROOT, 'dist/build/mp-weixin/utils/cloud.js')
let distDevMode = null
if (fs.existsSync(distCloudPath)) {
  const m = fs.readFileSync(distCloudPath, 'utf8').match(/DEV_MODE\s*=\s*(!0|!1|true|false)/)
  if (m) distDevMode = (m[1] === '!1' || m[1] === 'false') ? 'false' : 'true'
}
const srcLiteral = cloudSrc.match(/DEV_MODE\s*=\s*(true|false)/)
const DEV_MODE = distDevMode || (srcLiteral ? srcLiteral[1] : '(编译期注入)')

if (!API_BASE) {
  rec('must', '接口地址 API_BASE', '没找到，cloud.js 结构可能变了')
} else if (/^https:\/\//.test(API_BASE)) {
  rec('info', '接口地址协议', `${API_BASE}（https ✓）`)
} else if (/^http:\/\//.test(API_BASE)) {
  const isPrivate = /(127\.0\.0\.1|localhost|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(API_BASE)
  rec('must', '接口地址协议',
    `${API_BASE} 是 http${isPrivate ? ' 且是内网地址' : ''} → ` +
    `微信小程序**正式版只允许 https + 已备案域名**，http 请求会被直接拦断。` +
    `体验版/开发版需在开发者工具勾「不校验合法域名」才能用`)
} else {
  rec('must', '接口地址协议', `无法识别的地址：${API_BASE}`)
}

if (distDevMode === 'true') {
  rec('must', 'DEV_MODE（生产包是否自动登录）',
    '构建产物里 DEV_MODE = true → 审核员一打开就会被自动登录成测试身份，看不到登录流程和未登录首页，' +
    '会以「未提供可浏览内容 / 一进入就要求授权登录」被拒。检查 vite.config.js 的 __DEV_LOGIN__ 注入规则')
} else if (distDevMode === 'false') {
  rec('info', 'DEV_MODE（生产包是否自动登录）', '构建产物里为 false ✓ 生产包不会自动登录')
} else {
  rec('note', 'DEV_MODE（生产包是否自动登录）',
    `源码为编译期注入（当前解析为 ${DEV_MODE}），产物未检测到 → 先构建一次再核对`)
}

// ---------------------------------------------------------------- C. 权限与隐私
const mwPerm = (manifest['mp-weixin'] && manifest['mp-weixin'].permission) || projCfg.permission || null
const rpi = (manifest['mp-weixin'] && manifest['mp-weixin'].requiredPrivateInfos) || null
if (mwPerm || rpi) {
  rec('must', 'manifest 权限声明',
    `发现残留声明 permission=${JSON.stringify(mwPerm)} requiredPrivateInfos=${JSON.stringify(rpi)} → 会污染隐私审核，建议清空`)
} else {
  rec('info', 'manifest 权限声明', '无残留声明 ✓')
}

/** 需要《隐私保护指引》的敏感接口 */
const PRIVACY_APIS = [
  'getUserProfile', 'getLocation', 'chooseLocation', 'chooseImage', 'chooseMedia',
  'chooseVideo', 'getClipboardData', 'saveImageToPhotosAlbum', 'saveVideoToPhotosAlbum',
  'getRecorderManager', 'startRecord', 'chooseAddress', 'getWeRunData', 'openBluetoothAdapter'
]
const vueFiles = []
;(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(vue|js)$/.test(f)) vueFiles.push(p)
  }
})(path.join(ROOT, 'src'))

const usedPrivacy = {}
for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8')
  for (const api of PRIVACY_APIS) {
    if (new RegExp('\\b' + api + '\\s*\\(').test(src)) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/')
      if (!usedPrivacy[api]) usedPrivacy[api] = []
      usedPrivacy[api].push(rel)
    }
  }
}
if (Object.keys(usedPrivacy).length) {
  const detail = Object.entries(usedPrivacy).map(([k, v]) => `${k}（${v.length} 处）`).join('、')
  rec('note', '敏感接口使用情况',
    `${detail} → 用到了就必须在微信后台填《隐私保护指引》，否则审核驳回`)
} else {
  rec('info', '敏感接口使用情况', '未使用需要隐私授权的接口 ✓')
}

// 明确不该出现的旧声明（上轮踩过的坑）
if (/scope\.userLocation/.test(JSON.stringify(manifest)) || /scope\.userLocation/.test(JSON.stringify(projCfg))) {
  rec('must', '残留 scope.userLocation', 'manifest/project.config 里还有位置权限声明，但代码并无调用 → 会污染隐私审核')
} else {
  rec('info', '残留 scope.userLocation', '无 ✓')
}

// ---------------------------------------------------------------- D. 页面完整性
const pagesJson = readJson(path.join(ROOT, 'src/pages.json')) || {}
const pages = pagesJson.pages || []
let missing = []
for (const pg of pages) {
  if (!fs.existsSync(path.join(ROOT, 'src', pg.path + '.vue'))) missing.push(pg.path)
}
if (missing.length) {
  rec('must', '页面文件存在性', `${missing.length} 个注册页面找不到 .vue：${missing.join(', ')}`)
} else {
  rec('info', '页面文件存在性', `${pages.length} 个页面全部存在 ✓`)
}

const tabList = (pagesJson.tabBar && pagesJson.tabBar.list) || []
const tabPaths = tabList.map((t) => t.pagePath)
const notInPages = tabPaths.filter((t) => !pages.some((p) => p.path === t))
if (notInPages.length) {
  rec('must', 'tabBar 页面注册', `这些 tabBar 页面不在 pages 里：${notInPages.join(', ')}（小程序启动即报错）`)
} else {
  rec('info', 'tabBar 页面注册', `${tabPaths.length} 个 tab 页面均已注册 ✓`)
}

// ---------------------------------------------------------------- E. 构建产物
const distDir = path.join(ROOT, 'dist/build/mp-weixin')
if (fs.existsSync(distDir)) {
  const appJson = readJson(path.join(distDir, 'app.json')) || {}
  const distPages = (appJson.pages || []).length
  rec('info', '构建产物', `dist/build/mp-weixin 已生成，app.json 里 ${distPages} 个页面`)
  if (distPages !== pages.length) {
    rec('must', '构建产物页面数', `产物 ${distPages} 个 ≠ 源码 ${pages.length} 个，构建可能有问题`)
  }
} else {
  rec('note', '构建产物', '尚未构建（先跑 npm run build:mp-weixin）')
}

// ---------------------------------------------------------------- F. 审核驳回项回归核验
// 以下 4 项对应 2026-10-01 那次提审被拒的原因。放进自检，防止以后被改回去。
// （接口地址那条在 B 段已覆盖：http + IP 就是当时「白屏」的根因）

// 1) 两个协议页必须存在且已注册路由
const agreementFiles = ['src/pages/agreement/user.vue', 'src/pages/agreement/privacy.vue']
const missingAgreement = agreementFiles.filter((f) => !fs.existsSync(path.join(ROOT, f)))
const unregisteredAgreement = ['pages/agreement/user', 'pages/agreement/privacy']
  .filter((p) => !pages.some((pg) => pg.path === p))
if (missingAgreement.length || unregisteredAgreement.length) {
  rec('must', '协议页面（用户服务协议 / 隐私政策）',
    (missingAgreement.length ? `缺文件：${missingAgreement.join('、')}；` : '') +
    (unregisteredAgreement.length ? `未注册路由：${unregisteredAgreement.join('、')}；` : '') +
    '微信审核要求必须提供，缺失会被驳回')
} else {
  rec('info', '协议页面（用户服务协议 / 隐私政策）', '两个协议页均存在且已注册 ✓')
}

// 2) 协议里的【占位符】必须替换成真实信息
const legalPath = path.join(ROOT, 'src/utils/legal.js')
if (fs.existsSync(legalPath)) {
  // 只认「被引号包住的字符串里的占位符」，
  // 否则会把文件头注释里举例用的【】也算成未替换项
  const holders = [...fs.readFileSync(legalPath, 'utf8')
    .matchAll(/=\s*'([^'\n]*【[^】]*】[^'\n]*)'/g)].map((m) => m[1])
  if (holders.length) {
    rec('must', '协议主体信息（占位符）',
      `还有 ${holders.length} 处没替换：${[...new Set(holders)].join('、')} → 带占位符提审必被驳回`)
  } else {
    rec('info', '协议主体信息（占位符）', '主体名称与联系方式已填写 ✓')
  }
} else {
  rec('must', '协议主体信息', 'src/utils/legal.js 不存在，协议内容会引用失败')
}

// 2.5) 主体类型自洽：本小程序注册主体是**个人**
//      （2026-10-16 踩到：协议里误填了「XX有限公司」，且正文多处称「本企业」）
if (fs.existsSync(legalPath)) {
  const opName = (fs.readFileSync(legalPath, 'utf8')
    .match(/OPERATOR_NAME\s*=\s*'([^'\n]*)'/) || [])[1] || ''
  if (opName && /公司|有限|集团|企业|厂/.test(opName)) {
    rec('must', '运营者主体与「个人主体」自洽',
      `OPERATOR_NAME = 「${opName}」像企业名称，但本小程序注册主体是**个人** → ` +
      `必须改成开发者本人真实姓名（与公众平台实名一致），否则协议的运营者与备案主体对不上`)
  } else if (opName) {
    rec('info', '运营者主体与「个人主体」自洽', `OPERATOR_NAME = 「${opName}」（个人姓名 ✓）`)
  }
}

// 2.6) 审核可见页面不得用「本企业 / 企业内部」等企业主体口吻
const ENT_SCOPE_FILES = [
  'src/pages/index/index.vue',
  'src/pages/login/login.vue',
  'src/pages/agreement/user.vue',
  'src/pages/agreement/privacy.vue'
]
const entHits = []
for (const rel of ENT_SCOPE_FILES) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) continue
  const n = (fs.readFileSync(p, 'utf8').match(/本企业|企业内部/g) || []).length
  if (n) entHits.push(`${rel}（${n} 处）`)
}
if (entHits.length) {
  rec('must', '企业主体口吻（个人主体不适用）',
    `${entHits.join('、')} 出现「本企业/企业内部」→ 个人主体这样写对不上，统一改「使用单位」口径`)
} else {
  rec('info', '企业主体口吻（个人主体不适用）', '审核可见页面均无「本企业」口吻 ✓')
}

// 3) 登录页必须有「主动同意协议」步骤，且不得默认勾选
const loginPath = path.join(ROOT, 'src/pages/login/login.vue')
if (fs.existsSync(loginPath)) {
  const loginSrc = fs.readFileSync(loginPath, 'utf8')
  const hasAgreeStep = /\bensureAgreed\b/.test(loginSrc)
  const defaultChecked = /agreed\s*=\s*ref\(\s*true\s*\)/.test(loginSrc)
  if (!hasAgreeStep) {
    rec('must', '登录同意协议步骤',
      '登录页没有要求用户同意协议 → 不满足「取得用户授权同意」，会被驳回')
  } else if (defaultChecked) {
    rec('must', '登录同意协议步骤',
      '协议被默认勾选 → 「默认勾选」在合规上属于未经同意的收集，必须让用户主动选择')
  } else {
    rec('info', '登录同意协议步骤', '需用户本次主动勾选（无预勾选）✓')
  }
} else {
  rec('must', '登录同意协议步骤', '找不到 pages/login/login.vue')
}

// 4) 首页在未登录时必须先展示可浏览内容，不能是登录墙
const homePath = path.join(ROOT, 'src/pages/index/index.vue')
if (fs.existsSync(homePath)) {
  const homeSrc = fs.readFileSync(homePath, 'utf8')
  if (!/feature-list|class="intro"/.test(homeSrc)) {
    rec('must', '首页未登录可浏览',
      '未登录时首页没有可浏览内容 → 会以「一进入就要求授权登录、未提供可浏览内容」被驳回')
  } else {
    rec('info', '首页未登录可浏览', '未登录状态提供系统介绍与功能说明 ✓')
  }
} else {
  rec('must', '首页未登录可浏览', '找不到 pages/index/index.vue')
}

// ---------------------------------------------------------------- 输出
const ORDER = { must: 0, note: 1, info: 2 }
const LABEL = { must: '[必须修]', note: '[要注意]', info: '[ 信息 ]' }
rows.sort((a, b) => ORDER[a.level] - ORDER[b.level])

console.log('='.repeat(78))
console.log('  小程序提交审核前 · 本地自检')
console.log('='.repeat(78))
for (const r of rows) {
  console.log(`${LABEL[r.level]} ${r.item}`)
  console.log(`         ${r.detail}`)
}
const must = rows.filter((r) => r.level === 'must').length
const note = rows.filter((r) => r.level === 'note').length
console.log('-'.repeat(78))
console.log(`  必须修 ${must} 项 · 要注意 ${note} 项 · 信息 ${rows.length - must - note} 项`)
console.log('='.repeat(78))
process.exit(0)
