/**
 * 页面「重新显示」时执行回调（小程序端可靠版）
 * ============================================================
 * 【为什么不直接用 @dcloudio/uni-app 的 onShow】
 * ------------------------------------------------------------
 * 真机上跑到页面 setup 里那句 `e.onShow($)` 时会抛
 *     TypeError: e.onShow is not a function
 * setup 就此中断 → render 从未执行 → setData 从未发生 →
 * 页面上只剩静态文字、{{插值}} 全空 = 整块白屏。
 * 根因是「编译产物里那个导出没了」（编译期 tree-shaking / 工具编译缓存
 * 代次不一致都会造成），所以「依赖 vendor 导出了某个 API」这条路本身就不稳。
 *
 * 【为什么可以用运行时挂钩子的办法绕过去】
 * ------------------------------------------------------------
 * 小程序页面（Component 构造器构造）的页面生命周期是 uni-app 自己注入的：
 *     Li = [onLoad, onShow, onHide, onUnload, ...]        // "onShow" 就在里面
 *     Di(methods, Li)  →  methods.onShow = function (e) {
 *                           return this.$vm && this.$vm.$callHook('onShow', e)
 *                        }
 * 而 $callHook 的实现是：
 *     const list = this.$[name]      // ← 回调数组挂在 vm.$[name]
 *     for (...) list[i](arg)
 * 也就是说：**往 vm.$['onShow'] 这个数组里 push 一个回调，页面每次显示都会被调用。**
 * 这条路走的是框架自己的调用点，整个过程都在运行时完成，
 * 不受编译期 tree-shaking、「导出被删」这类问题影响。
 *
 * 【实例从哪来：不用 getCurrentInstance】
 * ------------------------------------------------------------
 * 实测真机上 getCurrentInstance 同样不可用。但当前页面一定在页面栈里：
 * `getCurrentPages()` 的最后一项就是它，框架自己就是这么拿 vm 的
 * （pageLifetimes.show 里写的就是 `this.$vm.$callHook(...)`）。
 * 因此这里从页面栈取 `$vm`，并用 `typeof vm.$callHook === 'function'` 做真实性校验：
 * 校验不过就返回 false（调用方兜底跑一次），绝不会把页面搞成白屏。
 *
 * 【时序（决定了首屏不会重复请求）】
 * ------------------------------------------------------------
 *     attached（建立 this.$vm）→ onLoad → onShow → ready（$callHook('mounted')）
 * 所以在 onMounted 里注册时，本页首次 onShow 已经过去了，不会重复拉取；
 * 之后每次重新显示（从子页返回、切 tab）都会命中。
 *
 * 【用法】
 * ------------------------------------------------------------
 *     import { onPageShow as onShow } from '@/utils/on-page-show'
 *
 *     const __pageShowHandler = () => { ... }
 *     onMounted(() => {
 *       __pageShowHandler()         // 首屏一定加载
 *       onShow(__pageShowHandler)   // 之后每次重新显示都刷新
 *     })
 * ============================================================ */

const HOOK_KEY = 'onShow'

/** 取小程序全局的页面栈函数（不同端挂法略有差异，都兜一遍） */
function getPageStack() {
  try {
    if (typeof getCurrentPages === 'function') return getCurrentPages()
    if (typeof wx !== 'undefined' && typeof wx.getCurrentPages === 'function') {
      return wx.getCurrentPages()
    }
  } catch (e) {
    /* 取不到就算了，交给上层兜底 */
  }
  return []
}

/**
 * 找到当前页面的 Vue 实例（vm）。
 * vm 的特征：上面挂着 $callHook（框架注入），且 vm.$ 是保存钩子数组的内部实例。
 */
function pickPageVm(inst) {
  const candidates = []
  if (inst && typeof inst === 'object') {
    candidates.push(inst, inst.$)
  }

  const stack = getPageStack()
  const page = stack && stack.length ? stack[stack.length - 1] : null
  if (page) {
    candidates.push(page.$vm, page)
  }

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    if (!c || typeof c !== 'object') continue
    if (typeof c.$callHook !== 'function') continue
    if (!c.$ || typeof c.$ !== 'object') continue
    return c
  }
  return null
}

/**
 * 注册「页面显示」回调
 * @param {Function} handler 页面显示时执行
 * @param {object}   [inst]  可选的页面实例（默认自动从页面栈取）
 * @returns {boolean} 是否注册成功；false 时调用方应自己跑一次兜底
 */
export function onPageShow(handler, inst) {
  if (typeof handler !== 'function') return false

  const vm = pickPageVm(inst)
  if (!vm) return false

  // $callHook 读的是 vm.$[name]，所以要挂到 vm.$ 上
  const box = vm.$

  // 包一层：单个回调抛错不影响页面其它逻辑（异步错误也兜住）
  const wrapped = function () {
    try {
      const ret = handler.apply(this, arguments)
      if (ret && typeof ret.then === 'function') {
        ret.then(null, function (err) {
          console.error('[onPageShow]', err)
        })
      }
    } catch (err) {
      console.error('[onPageShow]', err)
    }
  }

  const prev = box[HOOK_KEY]

  // 幂等：同一个实例 + 同一个 handler 只注册一次。
  // （开发时工具热重载会拿同一个页面实例反复执行 setup，没这道保险回调会累积，
  //   表现为「从子页返回时同一批请求发好几次」）
  const registered = box.__onPageShowHandlers || (box.__onPageShowHandlers = [])
  if (registered.indexOf(handler) > -1) return true
  registered.push(handler)

  if (Array.isArray(prev)) {
    prev.push(wrapped)
  } else if (typeof prev === 'function') {
    box[HOOK_KEY] = [prev, wrapped]
  } else {
    box[HOOK_KEY] = [wrapped]
  }

  return true
}

export default onPageShow
