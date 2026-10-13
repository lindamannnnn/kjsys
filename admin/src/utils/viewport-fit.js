/**
 * 整页高度跟随「实际可见区域」 —— 修复「后台缩小后不铺满」（2026-10-11）
 * ============================================================
 * 现象
 *   浏览器把页面缩小后（截图里的 25%），整个后台只占可视区顶部约 1/4，
 *   下方大片空白；缩回 100% 也不会自己恢复。
 *
 * 根因
 *   布局壳用的是 CSS 「100vh」。vh 只在 layout viewport 变化时重算：
 *     · 浏览器 Ctrl+- 页面缩放  → layout viewport 会变，vh 跟着变，正常
 *     · 页面级缩放（扩展/部分浏览器内核的缩放）= CSS zoom 或 transform:scale
 *       → layout viewport 不变，vh 一动不动，元素被按比例缩小
 *       → 25% 缩放时整页渲染高度 = 视口高 × 0.25，正好只占 1/4（= 截图现象）
 *   纯 CSS 无法自救：父级百分比、vh、dvh 全都读的是 layout viewport。
 *
 * 解法
 *   放一个「宽度已知」的探针元素（1000px），用它的渲染宽度反算出缩放比：
 *       zoom = 探针渲染宽度 / 1000
 *   再把 CSS 变量 --app-h 设为 「视口高 ÷ 缩放比」，
 *   渲染后高度 = (innerHeight / zoom) × zoom = innerHeight → 正好铺满。
 *
 *   · 正常 100%         zoom = 1    → --app-h = innerHeight（与 100vh 等价，零副作用）
 *   · 浏览器 Ctrl+-     innerHeight 已随 zoom 变化，zoom(探针) = 1 → 仍然正确
 *   · 页面级 zoom 0.25  zoom = 0.25 → --app-h = innerHeight × 4，渲染后铺满 ✅
 *
 * CSS 侧配套：把 100vh 换成 var(--app-h, 100vh)（保留 vh 作兜底）。
 * ============================================================
 */
const PROBE_W = 1000
const VAR_H = '--app-h'
const VAR_W = '--app-w'
const FALLBACK_POLL_MS = 800

let probeEl = null
let lastH = 0
let lastW = 0
let timer = null
let queued = false

/** 常驻探针：固定宽度、不可见、不参与交互；跟着页面一起被缩放，所以能读出缩放比 */
function ensureProbe() {
  if (probeEl && probeEl.isConnected) return probeEl
  probeEl = document.createElement('div')
  probeEl.setAttribute('aria-hidden', 'true')
  probeEl.style.cssText =
    `position:fixed;left:0;top:-99999px;width:${PROBE_W}px;height:1px;` +
    'visibility:hidden;pointer-events:none;z-index:-1'
  document.body.appendChild(probeEl)
  return probeEl
}

/** 当前页面的渲染缩放比：1 = 未缩放，0.25 = 被缩成 1/4 */
function readZoom() {
  const w = ensureProbe().getBoundingClientRect().width
  const z = w > 0 ? w / PROBE_W : 1
  // 明显不合理的值（探针被隐藏/未布局）按 1 处理，避免把布局算崩
  return z > 0.02 && z < 40 ? z : 1
}

/** 把 --app-h / --app-w 同步成「渲染后正好等于视口」的 CSS 尺寸 */
export function syncAppHeight() {
  if (!document.body) return
  const zoom = readZoom()
  const h = Math.round(window.innerHeight / zoom)
  const w = Math.round(window.innerWidth / zoom)
  const root = document.documentElement
  if (h > 0 && h !== lastH) {
    lastH = h
    root.style.setProperty(VAR_H, `${h}px`)
  }
  if (w > 0 && w !== lastW) {
    lastW = w
    root.style.setProperty(VAR_W, `${w}px`)
  }
}

/** 合并同一帧内的多次触发，避免抖动 */
function queueSync() {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    syncAppHeight()
  })
}

/**
 * 安装：main.js 里调用一次即可
 * 说明：页面级缩放（CSS zoom）不会触发 resize 事件，故保留一个低频兜底轮询；
 *       轮询只读一次探针宽度，值没变就不写样式，开销可忽略。
 */
export function installViewportFit() {
  syncAppHeight()
  window.addEventListener('resize', queueSync)
  window.addEventListener('orientationchange', queueSync)
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueSync)

  if (timer) clearInterval(timer)
  timer = setInterval(syncAppHeight, FALLBACK_POLL_MS)
}
