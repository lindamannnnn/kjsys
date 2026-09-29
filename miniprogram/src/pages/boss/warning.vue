<template>
  <view class="container">
    <!-- 预警统计 -->
    <view class="warning-stats">
      <view class="stat-card">
        <text class="stat-value">{{ total }}</text>
        <text class="stat-label">预警物料</text>
      </view>
      <view class="idle-toggle" @click="toggleIdle">
        <text class="box">{{ includeIdle ? '☑' : '☐' }}</text>
        <text class="toggle-text">含从未出入库的物料</text>
      </view>
    </view>

    <!-- 预警列表 -->
    <scroll-view
      class="warning-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in warningList"
        :key="item._id"
        class="warning-item"
      >
        <view class="warning-icon">⚠️</view>
        <view class="warning-content">
          <view class="name-row">
            <text class="material-name">{{ item.name }}</text>
            <text v-if="severityText(item.severity)" class="severity" :class="item.severity">
              {{ severityText(item.severity) }}
            </text>
          </view>
          <text class="material-spec">{{ item.spec }}</text>
          <view class="stock-info">
            <text class="label">当前库存:</text>
            <text class="value danger">{{ item.current_stock }} {{ item.unit }}</text>
          </view>
          <view class="stock-info">
            <text class="label">预警库存:</text>
            <text class="value">{{ item.warning_stock }} {{ item.unit }}</text>
          </view>
          <view class="stock-info">
            <text class="label">缺口数量:</text>
            <text class="value danger">{{ item.shortage }} {{ item.unit }}</text>
          </view>
        </view>
        <view class="warning-action">
          <button class="btn-notify" @click="onNotify(item)">
            通知采购
          </button>
        </view>
      </view>

      <view v-if="warningList.length === 0" class="empty">
        <text class="empty-icon">✅</text>
        <text class="empty-text">暂无库存预警</text>
        <text class="empty-sub">所有物料库存正常</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { statsApi } from '@/utils/api'

const warningList = ref([])
const total = ref(0)
const refreshing = ref(false)
// 默认只看"有库存或流动过的"物料，避免几千条从没动过的档案料淹没真正要补的货
const includeIdle = ref(false)

function toggleIdle() {
  includeIdle.value = !includeIdle.value
  loadWarnings()
}

/** 预警严重程度文案 */
function severityText(level) {
  const map = { out: '已缺货', low: '低于预警', idle: '从未动过' }
  return map[level] || ''
}

function onRefresh() {
  loadWarnings()
}

async function loadWarnings() {
  try {
    const res = await statsApi.warning({
      page: 1,
      pageSize: 100,
      includeIdle: includeIdle.value
    })
    warningList.value = res.list || []
    total.value = res.total || 0
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    refreshing.value = false
  }
}

function onNotify(item) {
  uni.showToast({ title: `已通知采购: ${item.name}`, icon: 'none' })
}

onMounted(() => {
  loadWarnings()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx;
}

.warning-stats {
  margin-bottom: 20rpx;

  .stat-card {
    background: #fff3cd;
    border: 1rpx solid #ffc107;
    border-radius: 16rpx;
    padding: 40rpx;
    text-align: center;

    .stat-value {
      font-size: 60rpx;
      font-weight: bold;
      color: #856404;
      display: block;
    }

    .stat-label {
      font-size: 26rpx;
      color: #856404;
      margin-top: 12rpx;
      display: block;
    }
  }

  .idle-toggle {
    display: flex;
    align-items: center;
    gap: 12rpx;
    margin-top: 16rpx;
    padding: 0 8rpx;

    .box {
      font-size: 32rpx;
      color: #8a6a10;
    }

    .toggle-text {
      font-size: 24rpx;
      color: #666;
    }
  }
}

.warning-list {
  height: calc(100vh - 200rpx);
}

.warning-item {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
  border-left: 8rpx solid #f39c12;

  .warning-icon {
    font-size: 48rpx;
    margin-right: 20rpx;
  }

  .warning-content {
    flex: 1;

    .name-row {
      display: flex;
      align-items: center;
      gap: 12rpx;

      .material-name {
        font-size: 30rpx;
        font-weight: 500;
        color: #333;
      }

      .severity {
        font-size: 20rpx;
        padding: 4rpx 12rpx;
        border-radius: 6rpx;
        background: #fff3cd;
        color: #856404;

        &.out {
          background: #f8d7da;
          color: #721c24;
        }

        &.idle {
          background: #e2e3e5;
          color: #4b5157;
        }
      }
    }

    .material-spec {
      font-size: 24rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }

    .stock-info {
      display: flex;
      align-items: center;
      gap: 12rpx;
      margin-top: 12rpx;

      .label {
        font-size: 24rpx;
        color: #999;
      }

      .value {
        font-size: 26rpx;
        color: #333;

        &.danger {
          color: #e74c3c;
          font-weight: bold;
        }
      }
    }
  }

  .warning-action {
    display: flex;
    align-items: center;

    .btn-notify {
      background: #f39c12;
      color: #fff;
      font-size: 24rpx;
      padding: 12rpx 24rpx;
      border-radius: 8rpx;

      &::after {
        border: none;
      }
    }
  }
}

.empty {
  text-align: center;
  padding: 100rpx 40rpx;

  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }

  .empty-text {
    font-size: 32rpx;
    color: #333;
    display: block;
  }

  .empty-sub {
    font-size: 26rpx;
    color: #999;
    margin-top: 12rpx;
    display: block;
  }
}
</style>
