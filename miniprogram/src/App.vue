<script setup>
import { onLaunch } from '@dcloudio/uni-app'
import { useUserStore } from './store/user'
import { DEV_MODE, API_BASE } from './utils/cloud'

onLaunch(async () => {
  console.log('App Launch')

  const userStore = useUserStore()

  // 自建服务器版：启动时只做一件事——校验本地令牌是否还有效。
  // 这里刻意不做任何「离线演示」降级：
  // 连不上后端必须让人看得见（后续请求会报错并提示），
  // 而不是伪装成登录成功、显示一个不存在的「演示用户」。
  try {
    const ok = await userStore.checkLogin()

    // 开发模式（utils/cloud.js 里 DEV_MODE=true）且本地没有有效令牌时，
    // 直接用当前「开发身份」登录，省得每次都要手动点一次「微信一键登录」。
    // 身份可在「我的」页面切换，见 server/src/db/seed-dev.js。
    if (!ok && DEV_MODE) {
      await userStore.login()
    }
  } catch (err) {
    // 常见原因：后端没启动 / 真机连不到电脑 / 开发者工具没勾「不校验合法域名」。
    // 开发环境下必须明明白白弹出来（含排查提示），不能只 console 一句就装死。
    // ⚠️ 这里显示的必须是**编译期真实注入的 API_BASE**，不能写死 127.0.0.1 ——
    //    真机调试时 127.0.0.1 指的是手机自己，写死了会把人往错方向带。
    console.warn('[启动] 登录失败', err)
    if (DEV_MODE) {
      const msg = String((err && err.message) || err || '')
      // 提示要跟着「接口地址是哪一类」走，否则会把人往错方向带：
      //   · 局域网地址（192.168./10./172.16-31.）→ 手机必须和电脑同一 WiFi
      //   · 公网地址（隧道/服务器）→ 本地有没有起隧道、服务器有没有放行端口
      const isLanAddr = /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(API_BASE)
      const hints = isLanAddr
        ? [
            '后端是否在跑（无响应最常见）',
            '手机与电脑要连同一 WiFi（当前是局域网地址，用流量连不上）',
            '开发者工具「详情 → 本地设置」勾上「不校验合法域名」'
          ]
        : [
            '本机后端是否在跑（无响应最常见）',
            '反向隧道是否在线（隧道断了就报这个；重开：bash tunnel.sh）',
            '服务器防火墙是否放行该端口（公网连不上多半卡在这）',
            '开发者工具「详情 → 本地设置」勾上「不校验合法域名」'
          ]
      const marks = ['①', '②', '③', '④']
      uni.showModal({
        title: '自动登录失败（开发模式）',
        content: `${msg}\n\n当前接口：${API_BASE}\n\n排查：`
          + hints.map((h, i) => `\n${marks[i]} ${h}`).join(''),
        showCancel: false,
        confirmText: '知道了'
      })
    }
  }
})
</script>

<style>
/* 全局样式 */
page {
  background-color: #f5f5f5;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Segoe UI, Arial, Roboto, 'PingFang SC', 'miui', 'Hiragino Sans GB', 'Microsoft Yahei', sans-serif;
}

/* 主题色变量 */
:root {
  --primary-color: #1a1a2e;
  --out-color: #0F7A3D;
  --in-color: #0B4F95;
  --boss-color: #8A6A10;
  --danger-color: #e74c3c;
  --warning-color: #f39c12;
  --success-color: #27ae60;
  --text-color: #333333;
  --text-secondary: #666666;
  --text-placeholder: #999999;
  --border-color: #e0e0e0;
  --bg-color: #f5f5f5;
  --card-bg: #ffffff;
}
</style>
