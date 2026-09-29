<template>
  <view class="container">
    <!-- 个人信息卡片 -->
    <view class="profile-card">
      <view class="avatar-section">
        <image class="avatar" :src="userInfo?.avatar || '/static/default-avatar.png'" mode="aspectFill" />
        <view class="user-info">
          <text class="nickname">{{ userInfo?.real_name || userInfo?.nickname || '未设置' }}</text>
          <text class="role">{{ roleText }}</text>
        </view>
      </view>
    </view>

    <!-- 开发身份切换（只在开发模式显示；上线前 DEV_MODE 关掉，这块自动消失） -->
    <view v-if="DEV_MODE" class="section dev-section">
      <view class="section-title">开发身份（切角色看不同界面）</view>
      <view class="dev-tip">
        <text>点一下就能换成别的岗位重新登录，不用改代码。身份由 npm run seed:dev 创建。</text>
      </view>
      <view class="dev-list">
        <view
          v-for="d in DEV_IDENTITIES"
          :key="d.openid"
          class="dev-item"
          :class="{ active: d.openid === currentDevOpenid }"
          @click="switchDevIdentity(d)"
        >
          <view class="dev-item-main">
            <text class="dev-item-label">{{ d.label }}</text>
            <text class="dev-item-desc">{{ d.desc }}</text>
          </view>
          <text v-if="d.openid === currentDevOpenid" class="dev-item-check">当前</text>
        </view>
      </view>
    </view>

    <!-- 待审核：提交真实姓名 -->
    <view v-if="isPending" class="section">
      <view class="section-title">提交真实姓名（待审核）</view>
      <view class="form-item">
        <text class="label">真实姓名</text>
        <input v-model="registerName" class="input" placeholder="请输入真实姓名" placeholder-class="placeholder" />
      </view>
      <view class="form-item">
        <text class="label">手机号（选填）</text>
        <input v-model="registerPhone" class="input" type="number" placeholder="请输入手机号" placeholder-class="placeholder" />
      </view>
      <button class="btn-save" @click="onRegister">提交审核</button>
    </view>

    <!-- 资料设置 -->
    <view class="section">
      <view class="section-title">资料设置</view>
      <view class="form-item">
        <text class="label">真实姓名</text>
        <input v-model="editName" class="input" placeholder="请输入真实姓名" placeholder-class="placeholder" />
      </view>
      <view class="form-item">
        <text class="label">手机号</text>
        <input v-model="editPhone" class="input" type="number" placeholder="请输入手机号" placeholder-class="placeholder" />
      </view>
      <button class="btn-save" @click="onSaveProfile">保存资料</button>
    </view>

    <!-- 功能列表 -->
    <view class="menu-list">
      <view class="menu-item" @click="goPage('/pages/my/profile')">
        <text class="menu-icon">👤</text>
        <text class="menu-text">个人信息</text>
        <text class="menu-arrow">></text>
      </view>

      <view class="menu-item" @click="goPage('/pages/out/history')">
        <text class="menu-icon">📋</text>
        <text class="menu-text">我的出库记录</text>
        <text class="menu-arrow">></text>
      </view>

      <view class="menu-item" @click="goPage('/pages/in/history')">
        <text class="menu-icon">📥</text>
        <text class="menu-text">我的入库记录</text>
        <text class="menu-arrow">></text>
      </view>

      <view class="menu-item" @click="goPage('/pages/check/list')">
        <text class="menu-icon">📊</text>
        <text class="menu-text">盘点任务</text>
        <text class="menu-arrow">></text>
      </view>

      <view class="menu-item" @click="showAbout">
        <text class="menu-icon">ℹ️</text>
        <text class="menu-text">关于系统</text>
        <text class="menu-arrow">></text>
      </view>
    </view>

    <!-- 最近操作记录 -->
    <view class="section">
      <view class="section-title">最近操作记录</view>
      <view v-if="logs.length === 0" class="logs-empty">
        <text>暂无记录</text>
      </view>
      <view v-for="log in logs" :key="log._id" class="log-item">
        <view class="log-main">
          <text class="log-action">{{ actionText(log.action) }}</text>
          <text class="log-detail">{{ log.detail }}</text>
        </view>
        <text class="log-time">{{ formatDate(log.created_at, 'MM-DD HH:mm') }}</text>
      </view>
    </view>

    <!-- 退出登录 -->
    <view class="logout-section">
      <button class="btn-logout" @click="onLogout">
        退出登录
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useUserStore } from '@/store/user'
import { authApi } from '@/utils/api'
import { formatDate } from '@/utils/format'
import { DEV_MODE, DEV_IDENTITIES, getDevOpenid, setDevOpenid } from '@/utils/cloud'

const userStore = useUserStore()

const userInfo = computed(() => userStore.userInfo)
const roles = computed(() => userStore.roles)
const isPending = computed(() => userStore.isPending)

const editName = ref('')
const editPhone = ref('')
const registerName = ref('')
const registerPhone = ref('')
const logs = ref([])

/* ------------------------------------------------------------
 * 开发身份切换（仅 DEV_MODE 时页面才显示这块）
 * 目的：验收不同岗位的界面时，不必改代码重新编译
 * ---------------------------------------------------------- */
const currentDevOpenid = ref(getDevOpenid())

async function switchDevIdentity(d) {
  if (!d || d.openid === currentDevOpenid.value) return

  const ok = await new Promise((resolve) => {
    uni.showModal({
      title: '切换开发身份',
      content: `换成「${d.label}」并重新登录？`,
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false)
    })
  })
  if (!ok) return

  uni.showLoading({ title: '切换中…', mask: true })
  try {
    setDevOpenid(d.openid)
    userStore.logout()        // 清掉旧令牌与旧身份
    await userStore.login()   // 用新身份重新登录
    currentDevOpenid.value = d.openid
    uni.hideLoading()
    uni.showToast({ title: `已切换为${d.label}`, icon: 'none' })
    setTimeout(() => uni.reLaunch({ url: '/pages/index/index' }), 900)
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '切换失败', icon: 'none' })
  }
}

// 用户信息变化时同步到编辑表单
watch(userInfo, (val) => {
  editName.value = val?.real_name || ''
  editPhone.value = val?.phone || ''
}, { immediate: true })

const roleText = computed(() => {
  const roleMap = {
    'out': '车间员工',
    'in': '仓库管理员',
    'purchase': '采购员',
    'storekeeper': '仓管员',
    'boss': '老板',
    'admin': '管理员'
  }
  return roles.value.map(r => roleMap[r] || r).join(' / ')
})

function actionText(action) {
  const map = {
    login: '登录',
    register: '提交注册',
    change_password: '修改密码',
    inbound_submit: '提交入库',
    inbound_confirm: '确认入库',
    inbound_cancel: '撤销入库',
    outbound_submit: '提交出库',
    outbound_confirm: '确认出库',
    outbound_reject: '驳回出库',
    outbound_cancel: '撤销出库'
  }
  return map[action] || action
}

function goPage(url) {
  uni.navigateTo({ url })
}

function showAbout() {
  uni.showModal({
    title: '关于系统',
    content: '胜龙进销存系统 v2.1\n微信小程序 + Web 后台管理',
    showCancel: false
  })
}

// 保存资料
async function onSaveProfile() {
  const realName = editName.value.trim()
  if (!realName) {
    uni.showToast({ title: '请输入真实姓名', icon: 'none' })
    return
  }
  try {
    uni.showLoading({ title: '保存中...' })
    await userStore.updateProfile({ real_name: realName, phone: editPhone.value.trim() })
    uni.hideLoading()
    uni.showToast({ title: '资料已更新', icon: 'success' })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '保存失败', icon: 'none' })
  }
}

// 待审核：提交真实姓名
async function onRegister() {
  const realName = registerName.value.trim()
  if (!realName) {
    uni.showToast({ title: '请输入真实姓名', icon: 'none' })
    return
  }
  try {
    uni.showLoading({ title: '提交中...' })
    await userStore.register({ real_name: realName, phone: registerPhone.value.trim() })
    uni.hideLoading()
    uni.showToast({ title: '已提交，请等待审核', icon: 'success' })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none' })
  }
}

// 最近操作记录
async function loadLogs() {
  try {
    const res = await authApi.myLogs({ limit: 20 })
    logs.value = res.list || []
  } catch (err) {
    logs.value = []
  }
}

function onLogout() {
  uni.showModal({
    title: '确认退出',
    content: '退出后需要重新登录',
    success: (res) => {
      if (res.confirm) {
        userStore.logout()
        uni.reLaunch({ url: '/pages/index/index' })
      }
    }
  })
}

onMounted(() => {
  loadLogs()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx;
}

.profile-card {
  background: linear-gradient(135deg, #1a1a2e, #16213e);
  border-radius: 20rpx;
  padding: 40rpx;
  margin-bottom: 30rpx;

  .avatar-section {
    display: flex;
    align-items: center;
    gap: 24rpx;

    .avatar {
      width: 120rpx;
      height: 120rpx;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
    }

    .user-info {
      .nickname {
        font-size: 36rpx;
        font-weight: bold;
        color: #fff;
        display: block;
      }

      .role {
        font-size: 26rpx;
        color: rgba(255, 255, 255, 0.7);
        margin-top: 8rpx;
        display: block;
      }
    }
  }
}

/* 开发身份切换块：虚线边框区别于业务卡片，一眼看出是开发用的 */
.dev-section {
  border: 2rpx dashed #0B4F95;

  .dev-tip {
    font-size: 24rpx;
    color: #8a8a8a;
    line-height: 1.6;
    margin-bottom: 20rpx;
  }

  .dev-list {
    .dev-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 22rpx 24rpx;
      border-radius: 12rpx;
      background: #f7f9fc;
      border: 2rpx solid transparent;
      margin-bottom: 12rpx;

      &:last-child {
        margin-bottom: 0;
      }

      &.active {
        background: #e8f1fb;
        border-color: #0B4F95;
      }

      .dev-item-main {
        display: flex;
        flex-direction: column;

        .dev-item-label {
          font-size: 28rpx;
          font-weight: bold;
          color: #333;
        }

        .dev-item-desc {
          font-size: 23rpx;
          color: #888;
          margin-top: 6rpx;
        }
      }

      .dev-item-check {
        font-size: 23rpx;
        color: #0B4F95;
        font-weight: bold;
      }
    }
  }
}

.section {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 30rpx;

  .section-title {
    font-size: 30rpx;
    font-weight: bold;
    color: #333;
    margin-bottom: 20rpx;
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
      padding: 20rpx 24rpx;
      font-size: 30rpx;
      width: 100%;
      box-sizing: border-box;
    }

    .placeholder {
      color: #999;
    }
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
  }

  .logs-empty {
    text-align: center;
    padding: 30rpx;
    color: #999;
    font-size: 26rpx;
  }

  .log-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 18rpx 0;
    border-bottom: 1rpx solid #f0f0f0;

    &:last-child {
      border-bottom: none;
    }

    .log-main {
      flex: 1;

      .log-action {
        font-size: 28rpx;
        color: #333;
        display: block;
      }

      .log-detail {
        font-size: 22rpx;
        color: #999;
        margin-top: 6rpx;
        display: block;
      }
    }

    .log-time {
      font-size: 22rpx;
      color: #999;
      margin-left: 16rpx;
    }
  }
}

.menu-list {
  background: #fff;
  border-radius: 16rpx;
  overflow: hidden;
  margin-bottom: 30rpx;

  .menu-item {
    display: flex;
    align-items: center;
    padding: 30rpx;
    border-bottom: 1rpx solid #f0f0f0;

    &:last-child {
      border-bottom: none;
    }

    .menu-icon {
      font-size: 36rpx;
      margin-right: 20rpx;
    }

    .menu-text {
      flex: 1;
      font-size: 30rpx;
      color: #333;
    }

    .menu-arrow {
      font-size: 32rpx;
      color: #ccc;
    }
  }
}

.logout-section {
  .btn-logout {
    background: #fff;
    color: #e74c3c;
    border-radius: 12rpx;
    padding: 28rpx;
    font-size: 30rpx;
    width: 100%;

    &::after {
      border: none;
    }
  }
}
</style>
