import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

/**
 * 开发登录开关（编译期常量，注入到 utils/cloud.js 的 DEV_MODE）
 *
 *   开启（true）：跳过微信登录，直接用内置测试身份（dev_worker_01 等）登录。
 *                仅用于本地开发与浏览器联调。
 *   关闭（false）：强制走真实微信登录（wx.login + 后端换 openid）。
 *
 * ⚠️ 判定规则刻意做成「只有开发态才开」，而不是「生产态才关」——
 *    这样即使将来改了构建命令、加了新平台，默认也是安全的那一侧。
 *
 *   - `uni -p mp-weixin` / `uni`（dev，mode=development）→ 开
 *   - `uni build -p mp-weixin`（提交审核的正式包，mode=production）→ 关
 *   - H5 构建（mode=production，但只用于本地浏览器验证，不会提交审核）→ 开
 *
 * 提交审核前可用 `node scripts/pre-submit-check.js` 复核产物里 DEV_MODE 是否为 false。
 */
function resolveDevLogin(mode) {
  // 手动覆盖，仅本地验证用：
  //   想在浏览器里检查「未登录」状态的界面（未登录首页 / 协议页 / 勾选拦截）时，
  //   用 FORCE_DEV_LOGIN=false 构建一版 H5 即可，不影响小程序生产包。
  if (process.env.FORCE_DEV_LOGIN === 'false') return false
  if (process.env.FORCE_DEV_LOGIN === 'true') return true

  if (mode === 'development') return true
  // H5 产物只用于本地/内网浏览器验证，不会进微信审核，故保留开发登录
  if (process.env.UNI_PLATFORM === 'h5') return true
  return false
}

export default defineConfig(({ mode }) => {
  const devLogin = resolveDevLogin(mode)

  // 接口地址注入（编译期常量，注入到 utils/cloud.js 的 API_BASE）
  //   - H5 构建：只用于本地浏览器验证 → 默认指向本地服务 http://127.0.0.1:3000，
  //     防止本地 UI 验证打到生产服务器（119.91.206.235）
  //   - 小程序构建 / 其他情况：注入空串 → 代码里回退到生产地址，行为与原来完全一致
  //   - 手动覆盖：API_BASE=http://192.168.x.x:3000 npm run build:h5
  const apiBase = process.env.API_BASE
    || (process.env.UNI_PLATFORM === 'h5' ? 'http://127.0.0.1:3000' : '')

  return {
    plugins: [uni()],
    define: {
      __DEV_LOGIN__: JSON.stringify(devLogin),
      __API_BASE__: JSON.stringify(apiBase)
    }
  }
})
