<template>
  <view class="container">
    <!-- 日期切换 -->
    <view class="date-tabs">
      <view
        v-for="tab in dateTabs"
        :key="tab.value"
        class="tab-item"
        :class="{ active: currentTab === tab.value }"
        @click="currentTab = tab.value"
      >
        {{ tab.label }}
      </view>
    </view>

    <!-- KPI 卡片 -->
    <view class="kpi-grid">
      <view class="kpi-card" v-for="kpi in kpiList" :key="kpi.label">
        <text class="kpi-value" :style="{ color: kpi.color }">{{ kpi.value }}</text>
        <text class="kpi-label">{{ kpi.label }}</text>
      </view>
    </view>

    <!-- 快捷入口 -->
    <view class="quick-actions">
      <view class="action-item" @click="goPage('/pages/boss/trend')">
        <text class="action-icon">📈</text>
        <text class="action-text">趋势分析</text>
      </view>
      <view class="action-item" @click="goPage('/pages/boss/stock')">
        <text class="action-icon">📦</text>
        <text class="action-text">库存台账</text>
      </view>
      <view class="action-item" @click="goPage('/pages/boss/orders')">
        <text class="action-icon">📋</text>
        <text class="action-text">单据流水</text>
      </view>
      <view class="action-item" @click="goPage('/pages/boss/warning')">
        <text class="action-icon">⚠️</text>
        <text class="action-text">库存预警</text>
      </view>
    </view>

    <!-- 库存预警提示 -->
    <view v-if="warningCount > 0" class="warning-banner" @click="goPage('/pages/boss/warning')">
      <text class="warning-icon">⚠️</text>
      <text class="warning-text">{{ warningCount }} 个物料库存不足，点击查看</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { statsApi } from '@/utils/api'

const currentTab = ref('today')
const dateTabs = [
  { label: '今天', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' }
]

const loading = ref(false)

const kpiData = ref({
  today_outbound_orders: 0,
  today_inbound_orders: 0,
  total_stock: 0,
  warning_count: 0
})

const warningCount = computed(() => kpiData.value.warning_count || 0)

const kpiList = computed(() => [
  // 命名统一（P2-1-06）：「单数」二字必须带，否则老板会当成出库数量
  { label: '今日出库单数', value: kpiData.value.today_outbound_orders || 0, color: '#e74c3c' },
  { label: '今日入库单数', value: kpiData.value.today_inbound_orders || 0, color: '#27ae60' },
  { label: '库存总量', value: kpiData.value.total_stock || 0, color: '#3498db' },
  { label: '预警物料', value: kpiData.value.warning_count || 0, color: '#f39c12' }
])

function goPage(url) {
  uni.navigateTo({ url })
}

async function loadData() {
  loading.value = true
  try {
    const res = await statsApi.overview()
    kpiData.value = {
      today_outbound_orders: res.today_outbound_orders || 0,
      today_inbound_orders: res.today_inbound_orders || 0,
      total_stock: res.total_stock || 0,
      warning_count: res.warning_count || 0
    }
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loading.value = false
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

.date-tabs {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  padding: 8rpx;
  margin-bottom: 20rpx;

  .tab-item {
    flex: 1;
    text-align: center;
    padding: 20rpx;
    font-size: 28rpx;
    color: #666;
    border-radius: 8rpx;
    transition: all 0.3s;

    &.active {
      background: #8A6A10;
      color: #fff;
      font-weight: 500;
    }
  }
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20rpx;
  margin-bottom: 20rpx;
}

.kpi-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  text-align: center;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .kpi-value {
    font-size: 48rpx;
    font-weight: bold;
    display: block;
  }

  .kpi-label {
    font-size: 26rpx;
    color: #666;
    margin-top: 12rpx;
    display: block;
  }
}

.quick-actions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20rpx;
  margin-bottom: 20rpx;

  .action-item {
    background: #fff;
    border-radius: 16rpx;
    padding: 30rpx 20rpx;
    text-align: center;
    box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

    .action-icon {
      font-size: 48rpx;
      display: block;
      margin-bottom: 12rpx;
    }

    .action-text {
      font-size: 24rpx;
      color: #666;
      display: block;
    }
  }
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 16rpx;
  background: #fff3cd;
  border: 1rpx solid #ffc107;
  border-radius: 12rpx;
  padding: 24rpx;

  .warning-icon {
    font-size: 36rpx;
  }

  .warning-text {
    font-size: 26rpx;
    color: #856404;
  }
}
</style>
