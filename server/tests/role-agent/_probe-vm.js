/**
 * 一次性探针：看真小程序里页面 vm 的结构，找「能驱动页面方法/数据」的可靠通道。
 * 起因：mp-review.js 里 callMethod('onTypeChange') 报 this.onTypeChange is not a function，
 *   evaluate 里 vm.selectedType 赋值也没生效 → 要亲眼看 uni-app vue3 编译后
 *   页面实例上到底挂的是什么。
 * 用法：node tests/role-agent/_probe-vm.js
 */
const automator = require('C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator')

const MP_API = process.env.MP_API || 'http://127.0.0.1:3000'
const WS = process.env.MP_WS || 'ws://localhost:9420'

;(async () => {
  const mp = await automator.connect({ wsEndpoint: WS })

  // 先切到厂长身份并进成品仓出库页
  await mp.evaluate(async (url) => {
    wx.setStorageSync('sl_dev_openid', 'dev_director')
    wx.removeStorageSync('sl_token')
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: `${url}/api/auth`, method: 'POST',
        data: { action: 'login', data: { dev_openid: 'dev_director' } },
        success: (r) => resolve(r.data), fail: reject
      })
    })
    if (res && res.code === 0) wx.setStorageSync('sl_token', res.data.token)
  }, MP_API)
  await mp.reLaunch('/pages/index/index')
  await new Promise((r) => setTimeout(r, 3000))
  await mp.navigateTo('/pages/out/submit?wh=chengpin')
  await new Promise((r) => setTimeout(r, 3000))

  // picker 只在清单非空时渲染，先点一个物料进清单
  {
    const page0 = await mp.currentPage()
    const mats = await page0.$$('.material-item')
    if (mats.length) { await mats[0].tap(); await new Promise((r) => setTimeout(r, 1200)) }
    console.log('物料数 =', mats.length)
  }

  const info = await mp.evaluate(() => {
    const pages = getCurrentPages()
    const cur = pages[pages.length - 1]
    const out = {
      pageKeys: Object.keys(cur).filter((k) => !k.startsWith('__')).slice(0, 30),
      hasVm: !!cur.$vm,
      vmType: cur.$vm ? typeof cur.$vm : 'none'
    }
    if (cur.$vm) {
      const vm = cur.$vm
      out.vmKeys = Object.keys(vm).filter((k) =>
        /type|submit|cart|select/i.test(k)).slice(0, 40)
      out.hasOnTypeChange = typeof vm.onTypeChange
      out.hasSelectedType = 'selectedType' in vm
      out.selectedTypeVal = JSON.stringify(vm.selectedType)
      out.hasOutTypes = 'outTypes' in vm
      out.outTypesIsArray = Array.isArray(vm.outTypes)
      out.outTypesVal = JSON.stringify(vm.outTypes)
      // $vm.$ 是 vue 组件内部实例？
      out.vmDollar = vm.$ ? Object.keys(vm.$).filter((k) => /setup|data|proxy/i.test(k)) : null
      if (vm.$ && vm.$.setupState) {
        out.setupKeys = Object.keys(vm.$.setupState).filter((k) => /type|submit/i.test(k))
        out.setupHasFn = typeof vm.$.setupState.onTypeChange
      }
      // setupState 是空的，再试 proxy（渲染代理，setup 绑定通常挂在这，ref 自动拆包）
      if (vm.$ && vm.$.proxy) {
        const px = vm.$.proxy
        out.proxyHasSelectedType = 'selectedType' in px
        out.proxySelectedType = JSON.stringify(px.selectedType)
        out.proxyOutTypes = JSON.stringify(px.outTypes)
        out.proxyOnTypeChange = typeof px.onTypeChange
      }
      // exposeProxy 也可能
      if (vm.$ && vm.$.exposeProxy) {
        out.exposeKeys = Object.keys(vm.$.exposeProxy).slice(0, 10)
      }
      // 页面 $vm 是 uni 的包装组件，真正的页面组件在子树里
      function dig(inst, depth) {
        if (!inst || depth > 4) return null
        const st = inst.setupState
        if (st && ('selectedType' in st || 'onTypeChange' in st)) {
          return {
            depth,
            keys: Object.keys(st).filter((k) => /type|submit/i.test(k)),
            fnType: typeof st.onTypeChange,
            selType: JSON.stringify(st.selectedType),
            outTypes: JSON.stringify(st.outTypes && (st.outTypes.value || st.outTypes))
          }
        }
        // 往子树找
        const sub = inst.subTree
        if (sub && sub.component) return dig(sub.component, depth + 1)
        if (sub && Array.isArray(sub.children)) {
          for (const ch of sub.children) {
            if (ch && ch.component) {
              const r = dig(ch.component, depth + 1)
              if (r) return r
            }
          }
        }
        return null
      }
      if (vm.$) out.found = dig(vm.$, 0)
      // uni-app vue3-mp：事件处理器以数据键形式挂在页面实例上（wxml 里 bindchange="{{D}}"）。
      // 直接调它就是最真实的一次「用户选了第 1 项」。
      // ⚠️ 第一版探针证明 cur.D 是 undefined → 处理器在 cur.data.D 里（wxml 数据键）。
      const handler = cur.D || (cur.data && cur.data.D)
      out.handlerType = typeof handler
      if (typeof handler === 'function') {
        try {
          handler.call(cur, { detail: { value: 1 } })
          out.called = true
        } catch (e) {
          out.callError = String(e && e.message || e)
        }
      } else if (cur.data && cur.data.D) {
        out.dataDType = typeof cur.data.D
        out.dataDValue = String(cur.data.D)
        // D 是处理器**名字**，真方法在页面实例上
        const m = cur[cur.data.D]
        out.methodType = typeof m
        if (typeof m === 'function') {
          try { m.call(cur, { detail: { value: 1 } }); out.called = true } catch (e) { out.callError = String(e && e.message || e) }
        }
      }
    }
    return out
  })
  console.log(JSON.stringify(info, null, 2))

  // 调完事件处理器后，从渲染层读 picker 回显与提交按钮状态
  await new Promise((r) => setTimeout(r, 800))
  const page = await mp.currentPage()
  const pv = await page.$('.picker-value')
  console.log('picker 回显 =', pv ? (await pv.text()) : '(找不到)')
  const btn = await page.$('.btn-submit')
  console.log('提交按钮 disabled =', btn ? await btn.attribute('disabled') : '(找不到)')

  // 再探：automator 的 attribute() 读 picker 的 bindchange 返回什么（套件里要用这条路）
  const pickerEl = await page.$('picker.picker')
  console.log('picker 元素存在 =', !!pickerEl)
  if (pickerEl) {
    for (const attr of ['bindchange', 'range-key', 'class']) {
      try { console.log(`attribute("${attr}") =`, JSON.stringify(await pickerEl.attribute(attr))) } catch (e) { console.log(`attribute("${attr}") 报错:`, e.message) }
    }
  }

  try { await mp.disconnect() } catch (e) { /* 无所谓 */ }
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
