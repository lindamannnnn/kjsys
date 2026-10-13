/**
 * 小程序全面 UI 走查（微信开发者工具模拟器 · 真实按键 · 只读）
 * ============================================================
 * 对应用户需求（2026-10-13）：「全面测试，前端小程序也要，用真实按键把所有流程跑一遍」
 *
 * 做什么：
 *   6 个岗位（领料员/采购员/配件仓管/成品仓管/厂长/老板）逐一以 dev_openid 登录，
 *   把各自能进的**每一个页面**真实打开：校验跳转成功、收集页面文本、抓「网络异常/加载失败」、
 *   截图存档。只读走查，不提交任何表单、不写业务数据。
 *
 * 用法：
 *   1. cli.bat auto --project <产物> --auto-port 9420   （IDE 需已在运行）
 *   2. node tests/role-agent/walkthrough-mp.js
 * ⚠️ 本脚本**结尾不调用 mp.close()**——close 会把 9420 自动化端口一起关掉，
 *    留给后续脚本/人工继续用；跑完直接在开发者工具里看。
 *
 * 输出：tests/role-agent/results/walkthrough-mp/<岗位>/<页面>.png + report.json
 * ============================================================
 */
require('../../src/config/env')

const fs = require('fs')
const path = require('path')
const automator = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator')

const MP_API = process.env.MP_API || 'http://127.0.0.1:3000'
const WS = process.env.MP_WS || 'ws://localhost:9420'
const SHOT_DIR = path.join(process.cwd(), 'tests/role-agent/results/walkthrough-mp')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const problems = []
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; problems.push({ label, detail }); console.log(`  ❌ ${label}${detail ? `  ← ${detail}` : ''}`) }
}

/** 换身份：写 dev_openid → 直连后端登录拿令牌 → 回首页 */
async function loginAs(mp, openid) {
  const code = await mp.evaluate(async ({ url, oid }) => {
    wx.setStorageSync('sl_dev_openid', oid)
    wx.removeStorageSync('sl_token')
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: `${url}/api/auth`,
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        data: { action: 'login', data: { dev_openid: oid } },
        success: (r) => resolve(r.data),
        fail: (e) => reject(new Error(JSON.stringify(e)))
      })
    })
    if (res && res.code === 0 && res.data && res.data.token) {
      wx.setStorageSync('sl_token', res.data.token)
      return 0
    }
    return (res && res.code) || -1
  }, { url: MP_API, oid: openid })
  if (code !== 0) throw new Error(`登录 ${openid} 失败 code=${code}`)
  await mp.reLaunch('/pages/index/index')
  await sleep(3500)
}

/** 收集当前页面所有 text 元素的文本（拼成一段，用于渲染判据与体验记录） */
async function pageText(page) {
  try {
    const els = await page.$$('text')
    const parts = []
    for (const el of els.slice(0, 400)) {
      const t = (await el.text()) || ''
      if (t.trim()) parts.push(t.trim())
    }
    return parts.join(' ')
  } catch (e) {
    return ''
  }
}

/** 打开一页并走查 */
async function visit(mp, name, pagePath, shotDir) {
  await mp.reLaunch(pagePath).catch((e) => ({ err: e.message }))
  await sleep(2800)
  const cur = await mp.currentPage()
  const gotPath = cur ? cur.path : '(取不到)'
  const text = await pageText(cur)
  const failed = /网络异常|加载失败|request:fail|检查网络/.test(text)
  const fname = pagePath.split('/').slice(-2).join('_')
  await mp.screenshot({ path: path.join(shotDir, `${fname}.png`) })
  const pathOk = gotPath === pagePath.replace(/^\//, '')
  ok(`${name} 打开 ${pagePath}`, pathOk && text.length > 10 && !failed,
    `path=${gotPath} 文本${text.length}字${failed ? ' 有网络异常' : ''}`)
  return { path: pagePath, gotPath, textLen: text.length, failed, textSample: text.slice(0, 100) }
}

/* 岗位 → 要走的页面 */
const PLANS = [
  {
    openid: 'dev_out', name: '领料员',
    pages: ['/pages/index/index', '/pages/out/submit', '/pages/out/scrap', '/pages/out/history',
      '/pages/message/list', '/pages/my/profile']
  },
  {
    openid: 'dev_purchase', name: '采购员',
    pages: ['/pages/index/index', '/pages/purchase/tasks', '/pages/purchase/ledger',
      '/pages/message/list', '/pages/my/profile']
  },
  {
    openid: 'dev_sk_parts', name: '配件仓管',
    pages: ['/pages/index/index', '/pages/storekeeper/dashboard', '/pages/storekeeper/stock',
      '/pages/storekeeper/orders', '/pages/storekeeper/pending', '/pages/in/submit', '/pages/in/history',
      '/pages/purchase/tasks', '/pages/check/list', '/pages/message/list', '/pages/my/profile']
  },
  {
    openid: 'dev_sk_goods', name: '成品仓管',
    pages: ['/pages/index/index', '/pages/storekeeper/dashboard', '/pages/storekeeper/stock',
      '/pages/storekeeper/orders', '/pages/in/submit', '/pages/in/history',
      '/pages/check/list', '/pages/message/list', '/pages/my/profile']
  },
  {
    openid: 'dev_director', name: '厂长',
    pages: ['/pages/index/index', '/pages/boss/dashboard', '/pages/purchase/task-create',
      '/pages/check/list', '/pages/message/list', '/pages/my/profile']
  },
  {
    openid: 'dev_boss', name: '老板',
    pages: ['/pages/index/index', '/pages/boss/dashboard', '/pages/boss/stock', '/pages/boss/orders',
      '/pages/boss/warning', '/pages/message/list', '/pages/my/profile']
  }
]

;(async () => {
  console.log('\n═══ 小程序全面 UI 走查（真实模拟器按键）═══\n')
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const mp = await automator.connect({ wsEndpoint: WS })
  console.log('已连接自动化端口', WS, '\n')

  const report = {}
  try {
    for (const plan of PLANS) {
      const dir = path.join(SHOT_DIR, plan.name)
      fs.mkdirSync(dir, { recursive: true })
      console.log(`\n■ ${plan.name}（${plan.openid}）`)
      await loginAs(mp, plan.openid)
      report[plan.name] = []
      for (const p of plan.pages) {
        const r = await visit(mp, plan.name, p, dir)
        report[plan.name].push(r)
      }
    }
  } catch (e) {
    console.error('走查中断：', e.message)
  }

  fs.writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

  // 注意：不 mp.close() —— close 会关掉 9420 自动化端口
  console.log(`\n──────── 走查完成：通过 ${pass} / 失败 ${fail} ────────`)
  console.log('截图：', SHOT_DIR)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('走查异常：', e); process.exit(1) })
