<template>
  <view class="container">
    <!-- 时间范围切换 -->
    <view class="time-tabs">
      <view
        v-for="tab in timeTabs"
        :key="tab.value"
        class="tab-item"
        :class="{ active: currentTab === tab.value }"
        @click="currentTab = tab.value; loadData()"
      >
        {{ tab.label }}
      </view>
    </view>

    <!-- 趋势图（模拟） -->
    <view class="chart-card">
      <view class="chart-header">
        <text class="chart-title">出入库趋势</text>
        <text class="chart-subtitle">{{ currentTab === '7d' ? '近 7 天' : '近 30 天' }}</text>
      </view>
      <view class="chart-body">
        <!-- 模拟图表 -->
        <view class="mock-chart">
          <view class="chart-line out-line" :style="{ height: chartHeights.out }"></view>
          <view class="chart-line in-line" :style="{ height: chartHeights.in }"></view>
          <view class="chart-legend">
            <view class="legend-item">
              <view class="legend-color" style="background: #e74c3c;"></view>
              <text>出库</text>
            </view>
            <view class="legend-item">
              <view class="legend-color" style="background: #27ae60;"></view>
              <text>入库</text>
            </view>
          </view>
        </view>
      </view>
    </view>

    <!-- 数据表格 -->
    <view class="data-card">
      <view class="card-header">
        <text class="section-title">每日数据</text>
      </view>
      <view class="card-body">
        <view class="table-header">
          <text class="col">日期</text>
          <text class="col">出库</text>
          <text class="col">入库</text>
          <text class="col">净变动</text>
        </view>
        <view
          v-for="item in tableData"
          :key="item.date"
          class="table-row"
        >
          <text class="col">{{ item.date }}</text>
          <text class="col out">{{ item.out }}</text>
          <text class="col in">{{ item.in }}</text>
          <text class="col" :class="{ positive: item.net > 0, negative: item.net < 0 }">
            {{ item.net > 0 ? '+' : '' }}{{ item.net }}
          </text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { statsApi } from '@/utils/api'

const currentTab = ref('7d')
const timeTabs = [
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' }
]

const loading = ref(false)
const tableData = ref([])

// 图表两根柱子的相对高度（按区间汇总单量占比）
const chartHeights = computed(() => {
  const sumOut = tableData.value.reduce((s, i) => s + Number(i.out || 0), 0)
  const sumIn = tableData.value.reduce((s, i) => s + Number(i.in || 0), 0)
  const max = Math.max(sumOut, sumIn, 1)
  return {
    out: `${Math.max(6, Math.round((sumOut / max) * 70))}%`,
    in: `${Math.max(6, Math.round((sumIn / max) * 70))}%`
  }
})

async function loadData() {
  loading.value = true
  try {
    const days = currentTab.value === '7d' ? 7 : 30
    const res = await statsApi.trend({ days })
    // 接口已按天补齐（无数据为 0），倒序展示最新在前
    tableData.value = (res.list || []).map(item => ({
      date: item.date,
      out: item.outbound_orders || 0,
      in: item.inbound_orders || 0,
      net: (item.inbound_orders || 0) - (item.outbound_orders || 0)
    })).reverse()
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

.time-tabs {
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

.chart-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .chart-header {
    margin-bottom: 30rpx;

    .chart-title {
      font-size: 32rpx;
      font-weight: bold;
      color: #333;
      display: block;
    }

    .chart-subtitle {
      font-size: 24rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }
  }

  .chart-body {
    .mock-chart {
      height: 300rpx;
      background: #f9f9f9;
      border-radius: 12rpx;
      position: relative;
      overflow: hidden;

      .chart-line {
        position: absolute;
        bottom: 0;
        width: 100%;
        height: 60%;
        border-radius: 8rpx;
        opacity: 0.3;

        &.out-line {
          background: linear-gradient(to top, #e74c3c, transparent);
        }

        &.in-line {
          background: linear-gradient(to top, #27ae60, transparent);
          height: 45%;
        }
      }

      .chart-legend {
        position: absolute;
        bottom: 20rpx;
        left: 20rpx;
        display: flex;
        gap: 30rpx;

        .legend-item {
          display: flex;
          align-items: center;
          gap: 12rpx;
          font-size: 24rpx;
          color: #666;

          .legend-color {
            width: 24rpx;
            height: 24rpx;
            border-radius: 4rpx;
          }
        }
      }
    }
  }
}

.data-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .card-header {
    margin-bottom: 20rpx;

    .section-title {
      font-size: 28rpx;
      font-weight: 500;
      color: #333;
    }
  }

  .card-body {
    .table-header {
      display: flex;
      padding: 20rpx 0;
      border-bottom: 2rpx solid #f0f0f0;
      font-size: 24rpx;
      color: #999;
      font-weight: 500;
    }

    .table-row {
      display: flex;
      padding: 20rpx 0;
      border-bottom: 1rpx solid #f0f0f0;
      font-size: 26rpx;

      &:last-child {
        border-bottom: none;
      }

      .col {
        flex: 1;
        text-align: center;
        color: #333;

        &.out {
          color: #e74c3c;
        }

        &.in {
          color: #27ae60;
        }

        &.positive {
          color: #27ae60;
          font-weight: bold;
        }

        &.negative {
          color: #e74c3c;
          font-weight: bold;
        }
      }
    }
  }
}
</style>
