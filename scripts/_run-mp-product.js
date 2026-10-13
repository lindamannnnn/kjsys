/**
 * 在 Node 里真实执行微信小程序产物，复现「页面挂载」全过程，抓 data 到底有没有被 setData。
 *
 * 关键事实：uni-app vue3 的 mp 产物里
 *     wx.createPage = (lc = cc, function (e) { return Component(nc(e, lc)) })
 *   —— 页面是用微信官方「Component 构造器构造页面」的方式注册的（基础库 2.2.3+），
 *      所以必须触发组件生命周期（created / lifetimes.attached / lifetimes.ready /
 *      pageLifetimes.show）才会走 Vue 的 $mount，setData 也才会发生。
 *
 * 用法：node scripts/_run-mp-product.js
 */
const path = require('path')
const fs = require('fs')

const DIST = path.resolve(__dirname, '../miniprogram/dist/build/mp-weixin')

const events = []
const setDataCalls = []
const componentOptionsList = []
let appInstance = null
let reqCount = 0

function log(tag, extra) {
  const line = extra === undefined ? tag : `${tag} :: ${extra}`
  events.push(line)
  console.log('[probe]', line)
}

process.on('uncaughtException', (e) => log('!! uncaughtException', (e && e.stack) || String(e)))
process.on('unhandledRejection', (e) => log('!! unhandledRejection', (e && e.stack) || String(e)))

const storage = new Map()

/* ---------------- wx mock ---------------- */
const baseWx = {
  canIUse: () => false,
  getAppBaseInfo: () => ({ SDKVersion: '3.5.0', version: '8.0.5', platform: 'devtools', language: 'zh_CN', theme: 'light' }),
  getDeviceInfo: () => ({
    brand: 'devtools', model: 'iPhone 15', system: 'iOS 16.0', platform: 'devtools',
    devicePixelRatio: 3, screenWidth: 390, screenHeight: 844, windowWidth: 390, windowHeight: 844,
    statusBarHeight: 47, safeArea: { top: 47, bottom: 810, height: 763, left: 0, right: 390 }
  }),
  getWindowInfo: () => ({
    pixelRatio: 3, screenWidth: 390, screenHeight: 844, windowWidth: 390, windowHeight: 844,
    statusBarHeight: 47, safeArea: { top: 47, bottom: 810, height: 763, left: 0, right: 390 }
  }),
  getSystemInfoSync: () => ({
    brand: 'devtools', model: 'iPhone 15', system: 'iOS 16.0', platform: 'devtools',
    SDKVersion: '3.5.0', version: '8.0.5', screenWidth: 390, screenHeight: 844,
    windowWidth: 390, windowHeight: 844, statusBarHeight: 47, language: 'zh_CN',
    devicePixelRatio: 3, safeArea: { top: 47, bottom: 810, height: 763, left: 0, right: 390 }
  }),
  getAppAuthorizeSetting: () => ({}),
  getSkylineInfo: () => ({ isSupported: false }),
  getLaunchOptionsSync: () => ({ scene: 1001, path: 'pages/index/index', query: {} }),
  getEnterOptionsSync: () => ({ scene: 1001, path: 'pages/index/index', query: {} }),
  getAccountInfoSync: () => ({ miniProgram: { appId: 'wx7c6f308d167e517c', envVersion: 'develop' } }),
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, v) },
  removeStorageSync: (k) => { storage.delete(k) },
  clearStorageSync: () => storage.clear(),
  getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),
  request: (opt) => {
    reqCount++
    log('wx.request', opt && opt.url)
    const res = {
      statusCode: 200, header: {}, cookies: [],
      data: {
        code: 0,
        data: {
          token: 'mock-token',
          user: { _id: 'u1', real_name: '测试用户', nickname: '测试', status: 'approved', roles: ['out', 'in', 'boss'], warehouse_ids: ['w1'] },
          list: [{ _id: 'w1', name: '主仓库' }],
          rejected_list: []
        }
      }
    }
    setTimeout(() => {
      if (opt && opt.success) opt.success(res)
      if (opt && opt.complete) opt.complete(res)
    }, 0)
    return { abort() {} }
  },
  login: (opt) => setTimeout(() => opt && opt.success && opt.success({ code: 'mock-code', errMsg: 'ok' }), 0),
  showToast: () => {}, hideToast: () => {}, showLoading: () => {}, hideLoading: () => {},
  showModal: (opt) => { log('wx.showModal', JSON.stringify(opt && opt.content).slice(0, 300)); if (opt && opt.success) opt.success({ confirm: true }) },
  navigateTo: (opt) => log('wx.navigateTo', opt && opt.url),
  redirectTo: () => {}, switchTab: () => {}, reLaunch: () => {}, navigateBack: () => {},
  setNavigationBarTitle: () => {}, showNavigationBarLoading: () => {}, hideNavigationBarLoading: () => {},
  getMenuButtonBoundingClientRect: () => ({ top: 51, bottom: 83, left: 278, right: 365, width: 87, height: 32 }),
  getUpdateManager: () => ({ onCheckForUpdate: () => {}, onUpdateReady: () => {}, onUpdateFailed: () => {}, applyUpdate: () => {} }),
  createSelectorQuery: () => ({
    in: function () { return this }, select: function () { return this }, selectAll: function () { return this },
    boundingClientRect: function () { return this }, scrollOffset: function () { return this },
    fields: function () { return this }, exec: (cb) => cb && cb([])
  }),
  createIntersectionObserver: () => ({
    relativeTo: function () { return this }, relativeToViewport: function () { return this },
    observe: () => {}, disconnect: () => {}
  }),
  createAnimation: () => ({
    export: () => ({}), step: function () { return this }, translate: function () { return this },
    scale: function () { return this }, opacity: function () { return this }
  }),
  nextTick: (cb) => setTimeout(cb, 0),
  reportEvent: () => {}, reportAnalytics: () => {},
  onAppShow: () => {}, onAppHide: () => {}, onError: () => {}, onUnhandledRejection: () => {},
  onPageNotFound: () => {}, onThemeChange: () => {}, onWindowResize: () => {},
  offAppShow: () => {}, offAppHide: () => {}, offError: () => {}, offUnhandledRejection: () => {},
  env: { USER_DATA_PATH: '/tmp/userdata' },
  getFileSystemManager: () => ({ readFile: (o) => o.fail && o.fail({}) })
}

const wx = new Proxy(baseWx, {
  get(t, k) {
    if (k in t) return t[k]
    if (typeof k === 'symbol') return undefined
    return function unknownWxApi() { return undefined }
  },
  set(t, k, v) { t[k] = v; return true },
  has() { return true }
})

global.wx = wx
global.__wxConfig = { pages: [], global: {}, appLaunchInfo: {} }
global.__uniConfig = { pages: [], globalStyle: {}, tabBar: { list: [] } }

let currentComponent = null
global.getApp = () => appInstance
global.getCurrentPages = () => (currentComponent ? [currentComponent] : [])

global.App = function (options) {
  appInstance = options
  log('App() 已注册', Object.keys(options || {}).join(','))
  return options
}

/** 真机上 Component() 无返回值；这里为了驱动生命周期给个实例 */
global.Component = function (options) {
  componentOptionsList.push(options)
  log('Component() 已注册', Object.keys(options || {}).join('|'))
  log('  初始 data', JSON.stringify(options && options.data))
  const inst = makeComponentInstance(options)
  currentComponent = inst
  scheduleLifecycles(inst, options)
  return inst
}

global.Page = function (options) {
  log('Page() 已注册', Object.keys(options || {}).join('|'))
  const inst = makeComponentInstance(options)
  currentComponent = inst
  scheduleLifecycles(inst, options)
  return inst
}

global.Behavior = function (o) { return o }

function makeComponentInstance(options) {
  const inst = {}
  // 组件方法挂实例（页面方法通常也在 methods 里）
  const methods = (options && options.methods) || {}
  for (const k in methods) inst[k] = methods[k]
  for (const k in options) {
    if (typeof options[k] === 'function' && k !== 'methods') inst[k] = options[k]
  }
  inst.data = JSON.parse(JSON.stringify((options && options.data) || {}))
  inst.properties = {}
  inst.is = 'pages/index/index'
  inst.route = 'pages/index/index'
  inst.id = 'index'
  inst.triggerEvent = () => {}
  inst.selectComponent = () => null
  inst.selectAllComponents = () => []
  inst.createSelectorQuery = baseWx.createSelectorQuery
  inst.setData = function (patch, cb) {
    setDataCalls.push(Object.keys(patch || {}).join(','))
    Object.assign(inst.data, patch)
    if (typeof cb === 'function') setTimeout(cb, 0)
  }
  inst.groupSetData = inst.setData
  return inst
}

function callHook(inst, label, fn) {
  if (typeof fn !== 'function') { return }
  try {
    const r = fn.apply(inst, [{}])
    if (r && typeof r.then === 'function') {
      r.catch((e) => log(`钩子 ${label} reject`, (e && e.stack) || String(e)))
    }
    log(`钩子 ${label} OK`)
  } catch (e) {
    log(`钩子 ${label} 抛错`, (e && e.stack) || String(e))
  }
}

function scheduleLifecycles(inst, options) {
  const lifetimes = (options && options.lifetimes) || {}
  const pageLifetimes = (options && options.pageLifetimes) || {}
  log('  lifetimes=', Object.keys(lifetimes).join('|'), ' pageLifetimes=', Object.keys(pageLifetimes).join('|'))

  setTimeout(() => {
    log('--- 开始驱动组件生命周期（按真机顺序）---')
    callHook(inst, 'created(options.created)', options.created)
    callHook(inst, 'lifetimes.created', lifetimes.created)
    callHook(inst, 'lifetimes.attached', lifetimes.attached)

    // 真机页面生命周期顺序：attached → onLoad → onShow → ready
    // 「Component 构造器构造页面」时，页面生命周期方法就挂在 methods 上（inst.onLoad / inst.onShow）
    callHook(inst, 'methods.onLoad', inst.onLoad)
    callHook(inst, 'methods.onShow(第1次/首屏)', inst.onShow)
    callHook(inst, 'lifetimes.ready', lifetimes.ready)

    // 关键验证：首屏 ready 之后钩子应已注册 —— 看 vm.$['onShow'] 里有没有东西
    setTimeout(() => {
      try {
        const vm = inst.$vm
        if (!vm) {
          log('钩子检查', 'inst.$vm 不存在')
        } else if (!vm.$ || typeof vm.$ !== 'object') {
          log('钩子检查', 'vm.$ 不存在，typeof vm=' + typeof vm)
        } else {
          const arr = vm.$['onShow']
          log('钩子检查 vm.$["onShow"]', Array.isArray(arr) ? `数组，length=${arr.length}` : `不是数组：${typeof arr}`)
          log('钩子检查 vm.$callHook', typeof vm.$callHook)
        }
      } catch (e) {
        log('钩子检查抛错', (e && e.stack) || String(e))
      }

      // 模拟「从子页返回」：再触发一次 onShow，看注册的回调有没有命中
      const before = reqCount
      const beforeSetData = setDataCalls.length
      log('=== 模拟从子页返回：再次触发 methods.onShow ===')
      callHook(inst, 'methods.onShow(第2次/返回)', inst.onShow)
      setTimeout(() => {
        log(`第 2 次 onShow 期间 wx.request 次数 = ${reqCount - before}`)
        log(`第 2 次 onShow 期间 setData 次数 = ${setDataCalls.length - beforeSetData}`)
      }, 500)
    }, 900)

    callHook(inst, 'pageLifetimes.resize', pageLifetimes.resize)
    setTimeout(() => log('--- 生命周期驱动结束 ---'), 1800)
  }, 0)
}

/* ---------------- 入口 ---------------- */
function main() {
  log('DIST', DIST)
  if (!fs.existsSync(DIST)) { log('FATAL', '产物目录不存在'); return summary() }

  // 预置登录令牌：让 checkLogin 走到「向后端确认」这一步，
  // 从而首屏真的会发请求、真的会 setData —— 后面第 2 次 onShow 才有可观测的差异
  storage.set('sl_token', 'mock-token')
  log('预置本地令牌 sl_token=mock-token')

  try {
    require(path.join(DIST, 'common/vendor.js'))
    log('require vendor.js OK', 'typeof wx.createPage=' + typeof wx.createPage)
  } catch (e) {
    log('require vendor.js FAILED', (e && e.stack) || String(e))
  }

  try {
    require(path.join(DIST, 'app.js'))
    log('require app.js OK')
  } catch (e) {
    log('require app.js FAILED', (e && e.stack) || String(e))
  }

  try {
    require(path.join(DIST, 'pages/index/index.js'))
    log('require pages/index/index.js OK')
  } catch (e) {
    log('require pages/index/index.js FAILED', (e && e.stack) || String(e))
  }

  setTimeout(summary, 2500)
}

function summary() {
  console.log('\n================ 结论 ================')
  console.log('Component 注册次数：', componentOptionsList.length)
  console.log('setData 调用次数：', setDataCalls.length)
  console.log('setData key 序列：', JSON.stringify(setDataCalls))
  if (currentComponent) {
    console.log('\n最终 data：')
    console.log(JSON.stringify(currentComponent.data, null, 2))
  } else {
    console.log('\n没有组件实例')
  }
  fs.writeFileSync(
    path.resolve(__dirname, '../.tmp-local-audit/mp-product-run.json'),
    JSON.stringify({ events, setDataCalls, data: currentComponent ? currentComponent.data : null }, null, 2)
  )
  console.log('\n(已落盘 .tmp-local-audit/mp-product-run.json)')
}

main()
