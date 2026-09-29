<script setup>
import { onLaunch } from '@dcloudio/uni-app'
import { useUserStore } from './store/user'
import { DEV_MODE } from './utils/cloud'

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
    // 常见原因：后端没启动。给出明确提示，不静默吞掉。
    console.warn('[启动] 登录失败', err)
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
