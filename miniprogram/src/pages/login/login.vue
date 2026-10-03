<template>
  <view class="container">
    <!-- 顶部 Logo -->
    <view class="logo-section">
      <view class="logo">🔧</view>
      <text class="app-name">胜龙进销存</text>
      <text class="app-desc">胜龙汽配内部管理系统</text>
    </view>

    <!-- 登录表单 -->
    <view class="login-form">
      <!-- 微信授权登录 -->
      <button
        v-if="!needProfile"
        class="btn-wechat"
        @click="handleWechatLogin"
      >
        <text class="wechat-icon">💬</text>
        <text>微信一键登录</text>
      </button>

      <!-- 填写真实姓名（首次登录） -->
      <view v-else class="profile-form">
        <view class="form-item">
          <text class="label">真实姓名</text>
          <input
            v-model="realName"
            class="input"
            placeholder="请输入真实姓名"
            placeholder-class="placeholder"
          />
        </view>

        <view class="form-item">
          <text class="label">手机号（选填）</text>
          <input
            v-model="phone"
            class="input"
            type="number"
            placeholder="请输入手机号"
            placeholder-class="placeholder"
          />
        </view>

        <button class="btn-submit" @click="handleSubmitProfile">
          提交审核
        </button>

        <text class="tip">提交后请等待管理员审核</text>
      </view>

      <!--
        测试账号一键登录（仅开发/测试构建可见）
        上线前用 npm run build:mp-weixin 出正式包时 DEV_MODE=false，这一整块会自动消失，
        不会被审核员看到，也不构成「绕过微信登录」的入口。
      -->
      <view v-if="DEV_MODE" class="dev-login">
        <view class="dev-head">
          <text class="dev-head-title">测试账号</text>
          <text class="dev-head-sub">点一下即以该岗位登录，无需微信授权</text>
        </view>
        <view class="dev-grid">
          <view
            v-for="d in DEV_IDENTITIES"
            :key="d.openid"
            class="dev-btn"
            :class="{ on: d.openid === currentDevOpenid }"
            @click="handleDevLogin(d)"
          >
            <text class="dev-btn-label">{{ d.label }}</text>
            <text class="dev-btn-desc">{{ d.desc }}</text>
          </view>
        </view>
        <text class="dev-note">账号由 npm run seed:dev 创建；正式包不包含本区域</text>
      </view>

      <!-- 协议同意（合规要求：不得默认勾选，必须由用户主动选择） -->
      <view class="agree-row">
        <view class="agree-box" :class="{ on: agreed }" @click="toggleAgree">
          <text v-if="agreed" class="agree-mark">✓</text>
        </view>
        <view class="agree-words">
          <text class="agree-plain" @click="toggleAgree">我已阅读并同意</text>
          <text class="agree-link" @click="openDoc('user')">《用户服务协议》</text>
          <text class="agree-plain" @click="toggleAgree">与</text>
          <text class="agree-link" @click="openDoc('privacy')">《隐私政策》</text>
        </view>
      </view>
    </view>

    <!-- 底部说明 -->
    <view class="footer">
      <text class="footer-text">仅限胜龙汽配内部员工使用</text>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { useUserStore } from '@/store/user'
import { DEV_MODE, DEV_IDENTITIES, getDevOpenid, setDevOpenid } from '@/utils/cloud'

const userStore = useUserStore()

const needProfile = ref(false)
const realName = ref('')
const phone = ref('')

// 是否已勾选同意协议。
// 刻意不做预勾选、也不从缓存里读回上次的选择 —— 默认勾选属于「未经用户同意」，
// 在合规上是被明确禁止的，必须由用户本次主动选择。
const agreed = ref(false)

function toggleAgree() {
  agreed.value = !agreed.value
}

// 打开协议页（用户服务协议 / 隐私政策）
function openDoc(type) {
  uni.navigateTo({ url: `/pages/agreement/${type}` })
}

// 未勾选同意时统一拦截，返回 false 表示不放行
function ensureAgreed() {
  if (agreed.value) return true
  uni.showToast({ title: '请先阅读并同意协议', icon: 'none', duration: 2200 })
  return false
}

// 各角色登录后的默认落点
const roleHome = {
  out: '/pages/out/submit',
  in: '/pages/in/submit',
  purchase: '/pages/purchase/submit',
  storekeeper: '/pages/storekeeper/dashboard',
  boss: '/pages/boss/dashboard'
}

// 按角色跳转
function goHome() {
  const roles = userStore.roles || []
  const hit = roles.find((r) => roleHome[r])
  if (hit) {
    uni.reLaunch({ url: roleHome[hit] })
  } else {
    uni.switchTab({ url: '/pages/index/index' })
  }
}

/* 当前测试身份（用于按钮高亮） */
const currentDevOpenid = ref(getDevOpenid())

/**
 * 测试账号一键登录
 * 刻意不检查协议勾选：这条通道只存在于开发/测试包里，不面向真实用户，
 * 每换一个岗位都要先勾一次协议会拖慢验收节奏。
 */
async function handleDevLogin(d) {
  if (!d) return

  try {
    uni.showLoading({ title: `以${d.label}登录…`, mask: true })
    setDevOpenid(d.openid)   // 先记住身份，loginWithWechat 会拿它去换令牌
    userStore.logout()       // 清掉上一个身份的令牌，避免两个岗位串号
    const res = await userStore.login()
    currentDevOpenid.value = d.openid
    uni.hideLoading()

    if (res && (res.isNew || res.needRegister)) {
      needProfile.value = true
      return
    }

    uni.showToast({ title: `已登录：${d.label}`, icon: 'none' })
    setTimeout(goHome, 700)
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '登录失败', icon: 'none' })
  }
}

// 微信登录（登录逻辑在 store 内统一封装）
async function handleWechatLogin() {
  if (!ensureAgreed()) return

  try {
    uni.showLoading({ title: '登录中...', mask: true })
    const res = await userStore.login()
    uni.hideLoading()

    if (res && (res.isNew || res.needRegister)) {
      // 首次进入：先填写真实姓名等待审核
      needProfile.value = true
      return
    }

    uni.showToast({ title: '登录成功', icon: 'success' })
    goHome()
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '登录失败', icon: 'none' })
  }
}

// 提交真实姓名，等待管理员审核
async function handleSubmitProfile() {
  if (!ensureAgreed()) return

  if (!realName.value.trim()) {
    uni.showToast({ title: '请输入真实姓名', icon: 'none' })
    return
  }

  try {
    uni.showLoading({ title: '提交中...', mask: true })
    await userStore.register({
      real_name: realName.value.trim(),
      phone: phone.value.trim()
    })
    uni.hideLoading()
    uni.showToast({ title: '提交成功，请等待审核', icon: 'success' })
    uni.switchTab({ url: '/pages/index/index' })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none' })
  }
}
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: linear-gradient(180deg, #1a1a2e 0%, #16213e 100%);
  display: flex;
  flex-direction: column;
}

.logo-section {
  text-align: center;
  padding: 120rpx 40rpx 80rpx;

  .logo {
    font-size: 100rpx;
    margin-bottom: 30rpx;
  }

  .app-name {
    font-size: 44rpx;
    font-weight: bold;
    color: #fff;
    display: block;
    margin-bottom: 16rpx;
  }

  .app-desc {
    font-size: 26rpx;
    color: rgba(255, 255, 255, 0.6);
    display: block;
  }
}

.login-form {
  flex: 1;
  padding: 0 60rpx;
}

.btn-wechat {
  background: #07c160;
  color: #fff;
  border-radius: 50rpx;
  padding: 28rpx;
  font-size: 32rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16rpx;

  .wechat-icon {
    font-size: 36rpx;
  }

  &::after {
    border: none;
  }
}

.profile-form {
  .form-item {
    margin-bottom: 40rpx;

    .label {
      font-size: 28rpx;
      color: rgba(255, 255, 255, 0.8);
      display: block;
      margin-bottom: 16rpx;
    }

    .input {
      background: rgba(255, 255, 255, 0.1);
      border: 1rpx solid rgba(255, 255, 255, 0.2);
      border-radius: 12rpx;
      padding: 24rpx 30rpx;
      font-size: 30rpx;
      color: #fff;
      width: 100%;
      box-sizing: border-box;
    }

    .placeholder {
      color: rgba(255, 255, 255, 0.4);
    }
  }

  .btn-submit {
    background: #07c160;
    color: #fff;
    border-radius: 12rpx;
    padding: 28rpx;
    font-size: 32rpx;
    width: 100%;
    margin-top: 20rpx;

    &::after {
      border: none;
    }
  }

  .tip {
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
    display: block;
    margin-top: 30rpx;
  }
}

/* 测试账号区（仅开发/测试包可见，正式包里 DEV_MODE=false 不渲染） */
.dev-login {
  margin-top: 44rpx;
  padding: 28rpx 24rpx 12rpx;
  border: 2rpx dashed rgba(255, 255, 255, 0.28);
  border-radius: 16rpx;
  background: rgba(255, 255, 255, 0.05);

  .dev-head {
    margin-bottom: 22rpx;

    .dev-head-title {
      font-size: 28rpx;
      font-weight: bold;
      color: #fff;
      display: block;
      margin-bottom: 8rpx;
    }

    .dev-head-sub {
      font-size: 22rpx;
      color: rgba(255, 255, 255, 0.55);
      display: block;
    }
  }

  .dev-grid {
    display: flex;
    flex-wrap: wrap;
  }

  .dev-btn {
    width: calc(50% - 10rpx);
    box-sizing: border-box;
    margin-bottom: 20rpx;
    padding: 20rpx 18rpx;
    border-radius: 12rpx;
    background: rgba(255, 255, 255, 0.1);
    border: 2rpx solid rgba(255, 255, 255, 0.16);

    &:nth-child(odd) {
      margin-right: 20rpx;
    }

    &.on {
      border-color: #07c160;
      background: rgba(7, 193, 96, 0.16);
    }

    .dev-btn-label {
      font-size: 28rpx;
      color: #fff;
      display: block;
      margin-bottom: 6rpx;
    }

    .dev-btn-desc {
      font-size: 20rpx;
      line-height: 1.4;
      color: rgba(255, 255, 255, 0.5);
      display: block;
    }
  }

  .dev-note {
    font-size: 20rpx;
    color: rgba(255, 255, 255, 0.35);
    display: block;
  }
}

/* 协议同意区 */
.agree-row {
  display: flex;
  align-items: flex-start;
  margin-top: 48rpx;
  padding: 0 4rpx;

  .agree-box {
    width: 34rpx;
    height: 34rpx;
    flex-shrink: 0;
    margin-top: 6rpx;
    margin-right: 14rpx;
    border: 2rpx solid rgba(255, 255, 255, 0.45);
    border-radius: 8rpx;
    display: flex;
    align-items: center;
    justify-content: center;

    &.on {
      background: #07c160;
      border-color: #07c160;
    }

    .agree-mark {
      font-size: 24rpx;
      color: #fff;
      line-height: 1;
    }
  }

  .agree-words {
    flex: 1;
    font-size: 24rpx;
    line-height: 1.7;
  }

  .agree-plain {
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.6);
  }

  .agree-link {
    font-size: 24rpx;
    color: #07c160;
  }
}

.footer {
  text-align: center;
  padding: 40rpx;

  .footer-text {
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.4);
  }
}
</style>
