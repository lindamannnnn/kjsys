<template>
  <view class="container">
    <view class="card">
      <view class="card-title">修改密码</view>

      <view class="tip">
        <text>改密用于解除「首次登录必须修改初始密码」的限制。</text>
        <text>如果你从来没用过账号密码登录（一直是微信登录），原密码留空即可，直接设置新密码；账号已有密码时请填写原密码。</text>
      </view>

      <view class="form-item">
        <text class="label">原密码</text>
        <input
          v-model="oldPassword"
          class="input"
          password
          placeholder="没有密码过可直接留空"
          placeholder-class="placeholder"
        />
      </view>

      <view class="form-item">
        <text class="label">新密码</text>
        <input
          v-model="newPassword"
          class="input"
          password
          placeholder="不少于 6 位"
          placeholder-class="placeholder"
        />
      </view>

      <view class="form-item">
        <text class="label">确认新密码</text>
        <input
          v-model="confirmPassword"
          class="input"
          password
          placeholder="再输入一次"
          placeholder-class="placeholder"
        />
      </view>

      <view v-if="errorMsg" class="error-text">{{ errorMsg }}</view>

      <button class="btn-save" :disabled="submitting" @click="onSubmit">
        {{ submitting ? '提交中…' : '确认修改' }}
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { authApi } from '@/utils/api'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const errorMsg = ref('')
// 提交闩锁：防止手快连点造成重复提交
const submitting = ref(false)

async function onSubmit() {
  if (submitting.value) return
  errorMsg.value = ''

  const nw = newPassword.value
  if (!nw || nw.length < 6) {
    errorMsg.value = '新密码长度不能少于 6 位'
    return
  }
  if (nw !== confirmPassword.value) {
    errorMsg.value = '两次输入的新密码不一致'
    return
  }
  // ⚠️ 这里**不**强制要求原密码：从没用过密码的微信用户没有原密码，
  //   直接留空设置即可；账号已有密码但留空/填错时，后端会回「原密码不正确」。

  submitting.value = true
  uni.showLoading({ title: '提交中...', mask: true })
  try {
    await authApi.changePassword({
      old_password: oldPassword.value,
      new_password: nw
    })
    uni.hideLoading()
    uni.showToast({ title: '密码已修改', icon: 'success' })
    // 改密会清掉 must_change_password 标记，刷新一次用户信息让前端状态同步
    if (userStore.refreshUser) userStore.refreshUser().catch(() => {})
    setTimeout(() => uni.navigateBack(), 1200)
  } catch (err) {
    uni.hideLoading()
    // 失败必须说清原因（原密码不对 / 太短 / 网络），不能静默
    errorMsg.value = err.message || '修改失败，请稍后重试'
    uni.showToast({ title: errorMsg.value, icon: 'none', duration: 3000 })
  } finally {
    submitting.value = false
  }
}
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx;
}

.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;

  .card-title {
    font-size: 32rpx;
    font-weight: bold;
    color: #333;
    margin-bottom: 20rpx;
  }

  .tip {
    background: #f7f9fc;
    border-radius: 12rpx;
    padding: 20rpx 24rpx;
    margin-bottom: 24rpx;

    text {
      display: block;
      font-size: 24rpx;
      color: #7a869a;
      line-height: 1.7;
    }
  }

  .form-item {
    margin-bottom: 20rpx;

    .label {
      font-size: 26rpx;
      color: #666;
      display: block;
      margin-bottom: 12rpx;
    }

    .input {
      background: #f5f5f5;
      border-radius: 12rpx;
      /* uni-app 默认给 uni-input 写死 height:1.4em + overflow:hidden，
         不写显式高度会把输入内容裁掉（项目统一口径） */
      height: 88rpx;
      line-height: 88rpx;
      padding: 0 24rpx;
      font-size: 30rpx;
      width: 100%;
      box-sizing: border-box;
    }

    .placeholder {
      color: #999;
    }
  }

  .error-text {
    font-size: 24rpx;
    color: #e74c3c;
    margin-bottom: 16rpx;
  }

  .btn-save {
    background: #1a1a2e;
    color: #fff;
    border-radius: 12rpx;
    padding: 24rpx;
    font-size: 30rpx;
    width: 100%;
    margin-top: 10rpx;

    &::after {
      border: none;
    }

    &:disabled {
      background: #ccc;
    }
  }
}
</style>
