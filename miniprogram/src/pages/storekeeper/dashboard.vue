<template>
  <view class="container">
    <!-- 顶部统计 -->
    <view class="stats-bar">
      <view class="stat-item">
        <text class="stat-value">{{ pendingCount }}</text>
        <text class="stat-label">待确认</text>
      </view>
      <view class="stat-item">
        <text class="stat-value">{{ todayCount }}</text>
        <text class="stat-label">今日单据</text>
      </view>
      <view class="stat-item">
        <text class="stat-value">{{ stockCount }}</text>
        <text class="stat-label">本仓物料</text>
      </view>
    </view>

    <!-- 功能入口 -->
    <view class="menu-grid">
      <view class="menu-card" @click="goPending">
        <view class="menu-icon">📋</view>
        <text class="menu-title">待确认单据</text>
        <text class="menu-desc">确认/作废出入库单</text>
        <view v-if="pendingCount > 0" class="badge">{{ pendingCount }}</view>
      </view>

      <view class="menu-card" @click="goOrders">
        <view class="menu-icon">📊</view>
        <text class="menu-title">全部流水</text>
        <text class="menu-desc">查看本仓所有单据</text>
      </view>

      <view class="menu-card" @click="goStock">
        <view class="menu-icon">📦</view>
        <text class="menu-title">本仓库存</text>
        <text class="menu-desc">查看本仓库存</text>
      </view>

      <view class="menu-card" @click="goCheck">
        <view class="menu-icon">✅</view>
        <text class="menu-title">盘点</text>
        <text class="menu-desc">库存盘点任务</text>
      </view>
    </view>

    <!-- 待确认单据预览 -->
    <view v-if="pendingList.length > 0" class="section">
      <view class="section-header">
        <text class="section-title">待确认单据</text>
        <text class="section-more" @click="goPending">查看全部 →</text>
      </view>
      <view
        v-for="item in pendingList.slice(0, 3)"
        :key="`${item.order_type}-${item._id}`"
        class="order-preview"
        @click="goDetail(item)"
      >
        <view class="order-preview-header">
          <text class="order-no">{{ item.order_no }}</text>
          <text class="order-type" :class="item.order_type">{{ item.order_type === 'out' ? '出库' : '入库' }}</text>
        </view>
        <text class="order-info">{{ item.operator_name }} 提交 | {{ item.item_count }} 项</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { statsApi, outboundApi, inboundApi } from '@/utils/api'

const pendingList = ref([])
const pendingCount = ref(0)
const todayCount = ref(0)
const stockCount = ref(0)

function goPending() {
  uni.navigateTo({ url: '/pages/storekeeper/pending' })
}

function goOrders() {
  uni.navigateTo({ url: '/pages/storekeeper/orders' })
}

function goStock() {
  uni.navigateTo({ url: '/pages/storekeeper/stock' })
}

function goCheck() {
  uni.navigateTo({ url: '/pages/check/list' })
}

function goDetail(item) {
  const url = item.order_type === 'out'
    ? `/pages/out/detail?id=${item._id}`
    : `/pages/in/detail?id=${item._id}`
  uni.navigateTo({ url })
}

// 待确认单据预览（合并出库 + 入库）
async function loadPendingPreview() {
  try {
    const [outRes, inRes] = await Promise.all([
      outboundApi.list({ status: 'pending', page: 1, pageSize: 3 }),
      inboundApi.list({ status: 'pending', page: 1, pageSize: 3 })
    ])
    const out = (outRes.list || []).map((o) => ({
      ...o, order_type: 'out', item_count: (o.items || []).length
    }))
    const inbound = (inRes.list || []).map((o) => ({
      ...o, order_type: 'in', item_count: (o.items || []).length
    }))
    pendingList.value = [...out, ...inbound]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  } catch (err) {
    pendingList.value = []
  }
}

async function loadData() {
  try {
    const [overview, outPending, inPending] = await Promise.all([
      statsApi.overview(),
      outboundApi.pendingCount(),
      inboundApi.pendingCount()
    ])

    todayCount.value = (overview.today_outbound_orders || 0) + (overview.today_inbound_orders || 0)
    stockCount.value = overview.material_count || 0
    pendingCount.value = (outPending.count || 0) + (inPending.count || 0)

    await loadPendingPreview()
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  }
}

onMounted(() => {
  loadData()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx;
}

.stats-bar {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .stat-item {
    flex: 1;
    text-align: center;

    .stat-value {
      font-size: 48rpx;
      font-weight: bold;
      color: #6b5b95;
      display: block;
    }

    .stat-label {
      font-size: 24rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }
  }
}

.menu-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20rpx;
  margin-bottom: 20rpx;
}

.menu-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  position: relative;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .menu-icon {
    font-size: 48rpx;
    margin-bottom: 16rpx;
  }

  .menu-title {
    font-size: 30rpx;
    font-weight: bold;
    color: #333;
    display: block;
  }

  .menu-desc {
    font-size: 22rpx;
    color: #999;
    margin-top: 8rpx;
    display: block;
  }

  .badge {
    position: absolute;
    top: 16rpx;
    right: 16rpx;
    background: #e74c3c;
    color: #fff;
    font-size: 20rpx;
    padding: 4rpx 12rpx;
    border-radius: 20rpx;
    min-width: 32rpx;
    text-align: center;
  }
}

.section {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20rpx;

    .section-title {
      font-size: 30rpx;
      font-weight: bold;
      color: #333;
    }

    .section-more {
      font-size: 24rpx;
      color: #6b5b95;
    }
  }
}

.order-preview {
  padding: 20rpx;
  background: #f8f8f8;
  border-radius: 12rpx;
  margin-bottom: 12rpx;

  .order-preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8rpx;

    .order-no {
      font-size: 26rpx;
      font-weight: 500;
      color: #333;
    }

    .order-type {
      font-size: 20rpx;
      padding: 4rpx 12rpx;
      border-radius: 6rpx;
      color: #fff;

      &.out {
        background: #e74c3c;
      }

      &.in {
        background: #27ae60;
      }
    }
  }

  .order-info {
    font-size: 22rpx;
    color: #666;
  }
}
</style>
