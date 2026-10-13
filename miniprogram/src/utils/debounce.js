/**
 * 搜索防抖（2026-10-09 新增）
 * ------------------------------------------------------------
 * 背景：全站「搜物料/搜单据」的输入框标准不统一 ——
 *   boss/stock.vue、purchase/ledger.vue 自己写了 300ms 定时器，
 *   而 out/submit、in/submit、storekeeper/stock、check/list 是 @input 直接发请求，
 *   近 2000 条物料下每敲一个字打一次接口（用户走查反馈「输入卡顿」）。
 * 统一到这里，避免以后又各写一套。
 *
 * 用法（页面里只用一个 ref 存包装后的函数）：
 *   import { debounce } from '@/utils/debounce'
 *   const onSearchInput = debounce(() => loadMaterials(), 300)
 * 注意：必须在组件 setup 作用域里创建（每页一个实例，不会互相串）。
 */
export function debounce(fn, wait = 300) {
  let timer = null
  const wrapped = function (...args) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn.apply(this, args)
    }, wait)
  }
  // 需要立刻执行（如回车搜索、点搜索按钮）时用得上
  wrapped.flush = function (...args) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    fn.apply(this, args)
  }
  // 页面卸载时调用，避免定时器在页面销毁后还在跑
  wrapped.cancel = function () {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return wrapped
}

export default debounce
