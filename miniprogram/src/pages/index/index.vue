<template>
  <view class="container">
    <!-- 顶部标题 -->
    <view class="header">
      <text class="title">胜龙进销存</text>
      <text class="subtitle">{{ companyName }}</text>
    </view>

    <!-- 加载中 -->
    <view v-if="isLoading" class="loading">
      <text>加载中...</text>
    </view>

    <!-- 未登录：先展示系统介绍，不做登录墙（审核要求：先让用户了解，再要求登录） -->
    <view v-else-if="!isLoggedIn" class="intro">
      <view class="intro-card">
        <text class="intro-lead">企业内部物资出入库管理系统</text>
        <text class="intro-text">
          本系统用于记录和管理本企业自有物资的入库、领料出库、库存盘点与库存账目，
          让每一笔物资的流向都能追溯到经手人，方便企业内部对账与管理。
        </text>
      </view>

      <text class="section-title">系统功能</text>
      <view class="feature-list">
        <view class="feature-item">
          <text class="feature-icon">🟢</text>
          <view class="feature-main">
            <text class="feature-name">领料出库</text>
            <text class="feature-desc">车间员工提交领料单，仓库管理员审核后出库</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">🔵</text>
          <view class="feature-main">
            <text class="feature-name">入库登记</text>
            <text class="feature-desc">物资到货入库，系统自动核算加权成本</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">🛒</text>
          <view class="feature-main">
            <text class="feature-name">采购入库</text>
            <text class="feature-desc">采购员录单，登记供应商、单价与金额明细</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">📦</text>
          <view class="feature-main">
            <text class="feature-name">仓管工作台</text>
            <text class="feature-desc">待办单据审核、驳回与库存查看</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">📋</text>
          <view class="feature-main">
            <text class="feature-name">库存盘点</text>
            <text class="feature-desc">发起盘点任务，盘点差异需审核通过后生效</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">📄</text>
          <view class="feature-main">
            <text class="feature-name">库存流水</text>
            <text class="feature-desc">每笔出入库可追溯，支持按物料对账核账</text>
          </view>
        </view>
      </view>

      <view class="intro-card notice-card-plain">
        <text class="notice-title-plain">使用说明</text>
        <text class="notice-text-plain">
          本系统仅面向本企业员工开放使用，不面向社会公众提供服务。
          首次使用时请用微信登录并填写真实姓名，由管理员审核通过、分配岗位权限后即可开始使用。
        </text>
      </view>

      <button class="btn-login" @click="goLogin">员工登录</button>

      <view class="legal-links">
        <text class="legal-link" @click="openDoc('user')">《用户服务协议》</text>
        <text class="legal-plain">·</text>
        <text class="legal-link" @click="openDoc('privacy')">《隐私政策》</text>
      </view>
    </view>

    <!-- 待审核 -->
    <view v-else-if="isPending" class="pending-prompt">
      <text class="prompt-text">账号审核中</text>
      <text class="prompt-sub">请等待管理员审核</text>
    </view>

    <!-- 已登录，显示角色入口 -->
    <view v-else class="logged-in">
      <!-- 被驳回提醒：提交人能立刻知道单子被退回、为什么退 -->
      <view v-if="notices.length" class="notice-card" @click="showNotices">
        <text class="notice-icon">⚠️</text>
        <view class="notice-main">
          <text class="notice-title">你有 {{ notices.length }} 张出库单被驳回</text>
          <text class="notice-sub">
            {{ notices[0].order_no }} · {{ notices[0].reject_reason || '未填写原因' }}
          </text>
        </view>
        <text class="notice-arrow">›</text>
      </view>

      <view class="role-grid">
        <!-- 车间入口 -->
        <view v-if="isOut" class="role-card role-card-out" @click="goOut">
          <view class="role-icon">🟢</view>
          <text class="role-title">领料出库</text>
          <text class="role-desc">车间员工使用</text>
        </view>

        <!-- 仓库入口 -->
        <view v-if="isIn" class="role-card role-card-in" @click="goIn">
          <view class="role-icon">🔵</view>
          <text class="role-title">入库登记</text>
          <text class="role-desc">仓库管理员使用</text>
        </view>

        <!-- 采购员入口 -->
        <view v-if="isPurchase" class="role-card role-card-purchase" @click="goPurchase">
          <view class="role-icon">🛒</view>
          <text class="role-title">采购入库</text>
          <text class="role-desc">采购员使用</text>
        </view>

        <!-- 仓管员入口 -->
        <view v-if="isStorekeeper" class="role-card role-card-storekeeper" @click="goStorekeeper">
          <view class="role-icon">📦</view>
          <text class="role-title">仓管工作台</text>
          <text class="role-desc">仓管员使用</text>
        </view>

        <!-- 老板入口 -->
        <view v-if="isBoss" class="role-card role-card-boss" @click="goBoss">
          <view class="role-icon">🟡</view>
          <text class="role-title">老板看板</text>
          <text class="role-desc">数据查看与管理</text>
        </view>

        <!-- 盘点入口（仓库和老板可见） -->
        <view v-if="hasRole(['in', 'storekeeper', 'boss'])" class="role-card role-card-check" @click="goCheck">
          <view class="role-icon">📋</view>
          <text class="role-title">库存盘点</text>
          <text class="role-desc">盘点任务与录入</text>
        </view>

        <!-- 库存流水（采购对账、仓管核流水、老板查账都能用） -->
        <view
          v-if="hasRole(['purchase', 'storekeeper', 'in', 'boss'])"
          class="role-card role-card-ledger"
          @click="goLedger"
        >
          <view class="role-icon">📄</view>
          <text class="role-title">库存流水</text>
          <text class="role-desc">每笔出入库可追溯</text>
        </view>
      </view>
    </view>

    <!-- 底部用户信息 -->
    <view v-if="isLoggedIn && !isPending" class="user-info">
      <text class="user-name">{{ userInfo?.real_name || userInfo?.nickname || '未设置姓名' }}</text>
      <text class="user-role">{{ roleText }}</text>
      <text class="user-warehouse">{{ warehouseText }}</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { useUserStore } from '@/store/user'
import { warehouseApi, outboundApi } from '@/utils/api'

const userStore = useUserStore()

const companyName = ref('胜龙汽配')
const warehouseList = ref([])
// 近 7 天自己提交、被仓管驳回的出库单
const notices = ref([])

async function loadNotices() {
  if (!userStore.isLoggedIn) return
  try {
    const res = await outboundApi.myNotice()
    notices.value = res.rejected_list || []
  } catch (err) {
    // 提醒拿不到不影响主流程，安静跳过
    notices.value = []
  }
}

function showNotices() {
  const lines = notices.value
    .slice(0, 5)
    .map(n => `${n.order_no}：${n.reject_reason || '未填写原因'}（${n.reject_operator_name || '仓管'}）`)
    .join('\n')
  uni.showModal({
    title: '被驳回的出库单',
    content: lines || '暂无',
    showCancel: false,
    confirmText: '知道了'
  })
}

const isLoading = computed(() => userStore.isLoading)
const isLoggedIn = computed(() => userStore.isLoggedIn)
const isPending = computed(() => userStore.isPending)
const isOut = computed(() => userStore.isOut)
const isIn = computed(() => userStore.isIn)
const isPurchase = computed(() => userStore.isPurchase)
const isStorekeeper = computed(() => userStore.isStorekeeper)
const isBoss = computed(() => userStore.isBoss)
const userInfo = computed(() => userStore.userInfo)
const roles = computed(() => userStore.roles)

const hasRole = (list) => userStore.hasRole(list)

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

const warehouseText = computed(() => {
  if (!warehouseList.value.length) return ''
  if (userStore.isBoss || userStore.isAdmin) return '全部仓库'

  const ids = (userInfo.value?.warehouse_ids || []).map(String)
  if (!ids.length) return '未分配仓库'

  const names = warehouseList.value
    .filter(w => ids.includes(String(w._id || w.id)))
    .map(w => w.name)

  return names.length ? names.join(' / ') : '未分配仓库'
})

function goLogin() {
  uni.navigateTo({ url: '/pages/login/login' })
}

// 打开协议页（用户服务协议 / 隐私政策）
function openDoc(type) {
  uni.navigateTo({ url: `/pages/agreement/${type}` })
}

function goOut() {
  uni.navigateTo({ url: '/pages/out/submit' })
}

function goIn() {
  uni.navigateTo({ url: '/pages/in/submit' })
}

function goPurchase() {
  uni.navigateTo({ url: '/pages/purchase/submit' })
}

function goStorekeeper() {
  uni.navigateTo({ url: '/pages/storekeeper/dashboard' })
}

function goBoss() {
  uni.navigateTo({ url: '/pages/boss/dashboard' })
}

function goCheck() {
  uni.navigateTo({ url: '/pages/check/list' })
}

function goLedger() {
  uni.navigateTo({ url: '/pages/purchase/ledger' })
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouseList.value = res.list || []
  } catch (err) {
    console.warn('仓库加载失败', err)
  }
}

// 首次进入即加载（onMounted 兜底，防止页面生命周期在某些端不触发导致空白）
// 之后每次页面重新显示时刷新（含从子页面返回），所以点完确认回到工作台红点会同步
const __pageShowHandler = async () => {
  await userStore.checkLogin()
  if (userStore.isLoggedIn) {
    loadWarehouses()
    loadNotices()
  }
}
onMounted(() => {
  __pageShowHandler()      // 首屏一定加载（onMounted 兜底，不依赖任何注册成功与否）
  onShow(__pageShowHandler)  // 之后每次页面重新显示（含从子页返回）都刷新
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  padding: 40rpx;
  background: #f5f5f5;
}

.header {
  text-align: center;
  margin-bottom: 60rpx;
  padding-top: 60rpx;

  .title {
    font-size: 48rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
  }

  .subtitle {
    font-size: 28rpx;
    color: #666;
    margin-top: 16rpx;
    display: block;
  }
}

.loading {
  text-align: center;
  padding: 100rpx 0;
  color: #999;
}

.pending-prompt {
  text-align: center;
  padding: 100rpx 40rpx;

  .prompt-text {
    font-size: 32rpx;
    color: #333;
    display: block;
    margin-bottom: 20rpx;
  }

  .prompt-sub {
    font-size: 26rpx;
    color: #999;
    display: block;
    margin-bottom: 40rpx;
  }
}

/* ===== 未登录时的系统介绍（审核要求：先可浏览，再登录） ===== */
.intro {
  padding-bottom: 40rpx;
}

.intro-card {
  background: #fff;
  border-radius: 20rpx;
  padding: 36rpx;
  margin-bottom: 32rpx;
  box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.06);

  .intro-lead {
    font-size: 32rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
    margin-bottom: 16rpx;
  }

  .intro-text {
    font-size: 27rpx;
    color: #555;
    line-height: 1.8;
    display: block;
  }
}

.section-title {
  font-size: 30rpx;
  font-weight: bold;
  color: #1a1a2e;
  display: block;
  margin: 8rpx 0 24rpx;
}

.feature-list {
  margin-bottom: 32rpx;
}

.feature-item {
  display: flex;
  align-items: flex-start;
  background: #fff;
  border-radius: 16rpx;
  padding: 28rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 10rpx rgba(0, 0, 0, 0.05);

  .feature-icon {
    font-size: 40rpx;
    margin-right: 22rpx;
    line-height: 1.2;
  }

  .feature-main {
    flex: 1;

    .feature-name {
      font-size: 29rpx;
      font-weight: 500;
      color: #1a1a2e;
      display: block;
      margin-bottom: 8rpx;
    }

    .feature-desc {
      font-size: 24rpx;
      color: #888;
      line-height: 1.6;
      display: block;
    }
  }
}

.notice-card-plain {
  background: #f7f8fa;
  box-shadow: none;
  border: 1rpx solid #e8e8ef;

  .notice-title-plain {
    font-size: 28rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
    margin-bottom: 14rpx;
  }

  .notice-text-plain {
    font-size: 25rpx;
    color: #666;
    line-height: 1.8;
    display: block;
  }
}

.btn-login {
  background: #1a1a2e;
  color: #fff;
  border-radius: 50rpx;
  padding: 28rpx;
  font-size: 32rpx;
  margin-top: 16rpx;

  &::after {
    border: none;
  }
}

.legal-links {
  text-align: center;
  margin-top: 32rpx;

  .legal-link {
    font-size: 24rpx;
    color: #0B4F95;
  }

  .legal-plain {
    font-size: 24rpx;
    color: #bbb;
    padding: 0 10rpx;
  }
}

.notice-card {
  display: flex;
  align-items: center;
  gap: 20rpx;
  background: #fff5f5;
  border: 1rpx solid #ffd6d6;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;

  .notice-icon {
    font-size: 40rpx;
  }

  .notice-main {
    flex: 1;

    .notice-title {
      font-size: 28rpx;
      color: #c0392b;
      font-weight: 500;
      display: block;
    }

    .notice-sub {
      font-size: 22rpx;
      color: #999;
      margin-top: 6rpx;
      display: block;
    }
  }

  .notice-arrow {
    font-size: 36rpx;
    color: #c0392b;
  }
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24rpx;
}

.role-card {
  background: #fff;
  border-radius: 20rpx;
  padding: 40rpx 30rpx;
  text-align: center;
  box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.08);
  transition: transform 0.2s;

  &:active {
    transform: scale(0.98);
  }

  &-out {
    background: linear-gradient(135deg, #0F7A3D, #0d8a45);
  }

  &-in {
    background: linear-gradient(135deg, #0B4F95, #0d5cab);
  }

  &-purchase {
    background: linear-gradient(135deg, #0B4F95, #0d5cab);
  }

  &-storekeeper {
    background: linear-gradient(135deg, #2c5f2d, #3d7a3f);
  }

  &-boss {
    background: linear-gradient(135deg, #8A6A10, #a07d14);
  }

  &-check {
    background: linear-gradient(135deg, #6b5b95, #7d6ba8);
  }

  .role-icon {
    font-size: 60rpx;
    margin-bottom: 20rpx;
  }

  .role-title {
    font-size: 32rpx;
    font-weight: bold;
    color: #fff;
    display: block;
    margin-bottom: 12rpx;
  }

  .role-desc {
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.8);
    display: block;
  }
}

.user-info {
  margin-top: 60rpx;
  text-align: center;
  padding: 30rpx;
  background: #fff;
  border-radius: 16rpx;

  .user-name {
    font-size: 30rpx;
    color: #333;
    font-weight: 500;
    display: block;
  }

  .user-role {
    font-size: 24rpx;
    color: #999;
    margin-top: 8rpx;
    display: block;
  }

  .user-warehouse {
    font-size: 22rpx;
    color: #8A6A10;
    margin-top: 8rpx;
    display: block;
  }
}
</style>
