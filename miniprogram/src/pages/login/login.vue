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

const userStore = useUserStore()

const needProfile = ref(false)
const realName = ref('')
const phone = ref('')

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

// 微信登录（登录逻辑在 store 内统一封装）
async function handleWechatLogin() {
  try {
    uni.showLoading({ title: '登录中...' })
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
  if (!realName.value.trim()) {
    uni.showToast({ title: '请输入真实姓名', icon: 'none' })
    return
  }

  try {
    uni.showLoading({ title: '提交中...' })
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

.footer {
  text-align: center;
  padding: 40rpx;

  .footer-text {
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.4);
  }
}
</style>
