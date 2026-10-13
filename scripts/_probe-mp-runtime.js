/**
 * 在 Node 里 mock 小程序环境，加载编译产物，捕获模块加载期 / 组件创建期 / setup 执行期的真实报错。
 * 目的：定位「首页白屏」是 setup 抛错，还是 wx.createPage 失败。
 */
const path = require('path')
const DIST = 'G:/sl/shenglong-erp/miniprogram/dist/build/mp-weixin'

// 万能对象：任何属性访问都返回自身，可调用、可赋值，避免 mock 不完整导致的假报错
const universal = new Proxy(function () { return universal }, {
  get(t, k) {
    if (typeof k === 'symbol') return undefined
    if (k === 'toString') return () => '[universal]'
    return universal
  },
  set() { return true },
  apply() { return universal },
  has() { return true }
})

const sysInfo = () => ({
  platform: 'devtools', system: 'iOS 16.0', model: 'iPhone 13',
  SDKVersion: '3.0.0', version: '8.0.5', language: 'zh_CN',
  windowWidth: 375, windowHeight: 667, screenWidth: 375, screenHeight: 667,
  pixelRatio: 2, statusBarHeight: 20, safeArea: { top: 20, bottom: 667, height: 647 },
  deviceOrientation: 'portrait', brand: 'devtools', fontSizeSetting: 16, benchmarkLevel: -1
})

const overrides = {
  canIUse: () => true,
  getSystemInfoSync: sysInfo,
  getSystemInfo: (o) => { o && o.success && o.success(sysInfo()) },
  getDeviceInfo: () => ({ platform: 'devtools' }),
  getWindowInfo: () => sysInfo(),
  getAppBaseInfo: () => ({ SDKVersion: '3.0.0', language: 'zh_CN', version: '8.0.5' }),
  getLaunchOptionsSync: () => ({ path: 'pages/index/index', query: {}, scene: 1001 }),
  getEnterOptionsSync: () => ({ path: 'pages/index/index', query: {}, scene: 1001 }),
  getStorageSync: () => '',
  setStorageSync: () => undefined,
  removeStorageSync: () => undefined,
  getAccountInfoSync: () => ({ miniProgram: { appId: 'wx7c6f308d167e517c', envVersion: 'develop' } }),
  getUpdateManager: () => universal,
  onError: () => undefined,
  onUnhandledRejection: () => undefined,
  reportEvent: () => undefined,
  reportMonitor: () => undefined
}

global.wx = new Proxy({}, {
  get(t, k) {
    if (typeof k === 'symbol') return undefined
    if (k in overrides) return overrides[k]
    if (!(k in t)) t[k] = function () { return universal }
    return t[k]
  },
  set(t, k, v) { t[k] = v; return true },
  has() { return true }
})

global.App = function (o) { global.__appOptions = o }
global.Page = function (o) { global.__pageOptions = o }
global.Component = function (o) { global.__componentOptions = o }
global.Behavior = function (o) { return o }
global.getApp = () => ({ globalData: {}, $vm: null })
global.getCurrentPages = () => []
global.global = global

function tryLoad(label, file) {
  try {
    require(path.join(DIST, file))
    console.log(`✓ ${label} 模块加载成功`)
    return true
  } catch (e) {
    console.log(`✗ ${label} 模块加载失败：${e.message}`)
    console.log(e.stack.split('\n').slice(0, 8).join('\n'))
    return false
  }
}

console.log('=== 1. vendor ===')
tryLoad('vendor', 'common/vendor.js')
console.log('wx.createPage =', typeof global.wx.createPage, '| wx.createApp =', typeof global.wx.createApp)

console.log('\n=== 2. app.js ===')
tryLoad('app', 'app.js')

console.log('\n=== 3. pages/index/index.js ===')
const okIndex = tryLoad('index', 'pages/index/index.js')
console.log('Page 配置键：', global.__pageOptions ? Object.keys(global.__pageOptions).join(', ') : '（无）')

console.log('\n=== 4. 模拟页面 onLoad（会触发 Vue 实例创建 + setup 执行）===')
if (okIndex && global.__pageOptions && global.__pageOptions.onLoad) {
  const ctx = {
    setData(d, cb) { console.log('  → setData 键:', Object.keys(d).slice(0, 14).join(',')); cb && cb() },
    data: {}, route: 'pages/index/index', options: {}, $vm: null,
    selectComponent: () => null, triggerEvent: () => {}, createSelectorQuery: () => universal
  }
  try {
    global.__pageOptions.onLoad.call(ctx, {})
    console.log('✓ onLoad 执行完成')
    console.log('  $vm 存在:', !!ctx.$vm)
    if (ctx.$vm) {
      console.log('  实例 hooks:', ['onShow', 'onLoad', 'onReady', 'm'].map(h => `${h}=${ctx.$vm[h] ? ctx.$vm[h].length : 0}`).join(' '))
      if (ctx.$vm.onShow) {
        console.log('  手动触发 onShow 回调...')
        ctx.$vm.onShow.forEach((h) => {
          try { h() } catch (e) { console.log('  ✗ onShow 回调抛错:', e.message) }
        })
      }
    }
  } catch (e) {
    console.log('✗ onLoad 执行抛错：', e.message)
    console.log(e.stack.split('\n').slice(0, 10).join('\n'))
  }
} else {
  console.log('（页面模块未加载成功或无 onLoad）')
}
