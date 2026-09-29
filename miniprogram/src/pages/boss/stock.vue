<template>
  <view class="container">
    <!-- 搜索栏 -->
    <view class="search-bar">
      <view class="search-input">
        <text class="search-icon">🔍</text>
        <input
          v-model="keyword"
          class="input"
          placeholder="搜索物料名称/规格"
          placeholder-class="placeholder"
          @input="onSearch"
        />
      </view>
      <view class="filter-btn" @click="onToggleWarning">
        <text :class="{ active: showWarningOnly }">⚠️ 只看预警</text>
      </view>
    </view>

    <!-- 库存总价值汇总 -->
    <view class="total-value-card">
      <text class="total-label">库存总价值</text>
      <text class="total-value">¥{{ totalCost }}</text>
    </view>

    <!-- 库存列表 -->
    <scroll-view
      class="stock-list"
      scroll-y
      @scrolltolower="loadMore"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in stockList"
        :key="item._id"
        class="stock-item"
        :class="{ warning: item.current_stock <= item.warning_stock }"
      >
        <view class="stock-header">
          <text class="material-name">{{ item.name }}</text>
          <text class="stock-badge" :class="{ warning: item.current_stock <= item.warning_stock }">
            {{ item.current_stock <= item.warning_stock ? '预警' : '正常' }}
          </text>
        </view>
        <view class="stock-body">
          <text class="material-spec">{{ item.spec }}</text>
          <text class="material-category">{{ item.category }}</text>
        </view>
        <view class="stock-footer">
          <view class="stock-info">
            <text class="label">当前库存</text>
            <text class="value" :class="{ warning: item.current_stock <= item.warning_stock }">
              {{ item.current_stock }} {{ item.unit }}
            </text>
          </view>
          <view class="stock-info">
            <text class="label">预警库存</text>
            <text class="value">{{ item.warning_stock }} {{ item.unit }}</text>
          </view>
          <view class="stock-info">
            <text class="label">库存价值</text>
            <text class="value">¥{{ formatMoney(item.stock_value) }}</text>
          </view>
        </view>
      </view>

      <view v-if="loadingMore" class="loading-more">
        <text>加载中...</text>
      </view>

      <view v-else-if="noMore" class="no-more">
        <text>没有更多了</text>
      </view>

      <view v-else-if="stockList.length === 0" class="empty">
        <text class="empty-icon">📦</text>
        <text class="empty-text">暂无库存数据</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { formatMoney } from '@/utils/format'
import { statsApi } from '@/utils/api'

const keyword = ref('')
const showWarningOnly = ref(false)
const stockList = ref([])
const totalValue = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loadingMore = ref(false)
const noMore = ref(false)
const refreshing = ref(false)

let searchTimer = null

// 库存总价值（接口按当前筛选条件汇总）
const totalCost = computed(() => formatMoney(totalValue.value))

function onSearch() {
  // 输入防抖，避免每敲一个字都请求一次
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    noMore.value = false
    loadStock()
  }, 300)
}

function onToggleWarning() {
  showWarningOnly.value = !showWarningOnly.value
  onRefresh()
}

function onRefresh() {
  page.value = 1
  noMore.value = false
  loadStock()
}

function loadMore() {
  if (!noMore.value && !loadingMore.value) {
    page.value++
    loadStock()
  }
}

async function loadStock() {
  if (loadingMore.value) return

  loadingMore.value = true
  try {
    const res = await statsApi.stockList({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value,
      showWarningOnly: showWarningOnly.value
    })
    const list = res.list || []
    stockList.value = page.value === 1 ? list : [...stockList.value, ...list]
    totalValue.value = res.total_value || 0
    noMore.value = list.length === 0 || stockList.value.length >= (res.total || 0)
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loadingMore.value = false
    refreshing.value = false
  }
}

onMounted(() => {
  loadStock()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 20rpx;
  padding: 20rpx;
  background: #fff;
  position: sticky;
  top: 0;
  z-index: 100;

  .search-input {
    flex: 1;
    display: flex;
    align-items: center;
    background: #f5f5f5;
    border-radius: 40rpx;
    padding: 16rpx 24rpx;

    .search-icon {
      font-size: 28rpx;
      margin-right: 12rpx;
    }

    .input {
      flex: 1;
      font-size: 28rpx;
    }

    .placeholder {
      color: #999;
    }
  }

  .filter-btn {
    padding: 16rpx 24rpx;
    font-size: 26rpx;
    color: #666;

    .active {
      color: #f39c12;
      font-weight: 500;
    }
  }
}

.total-value-card {
  background: linear-gradient(135deg, #8A6A10, #a07d14);
  border-radius: 16rpx;
  padding: 40rpx;
  margin: 20rpx;
  text-align: center;
  box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.1);

  .total-label {
    font-size: 26rpx;
    color: rgba(255, 255, 255, 0.8);
    display: block;
  }

  .total-value {
    font-size: 56rpx;
    font-weight: bold;
    color: #fff;
    display: block;
    margin-top: 12rpx;
  }
}

.stock-list {
  padding: 20rpx;
  height: calc(100vh - 300rpx);
}

.stock-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  &.warning {
    border-left: 8rpx solid #f39c12;
  }

  .stock-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16rpx;

    .material-name {
      font-size: 30rpx;
      font-weight: 500;
      color: #333;
    }

    .stock-badge {
      font-size: 22rpx;
      padding: 6rpx 16rpx;
      border-radius: 8rpx;
      background: #d4edda;
      color: #155724;

      &.warning {
        background: #fff3cd;
        color: #856404;
      }
    }
  }

  .stock-body {
    margin-bottom: 20rpx;

    .material-spec {
      font-size: 24rpx;
      color: #999;
      margin-right: 20rpx;
    }

    .material-category {
      font-size: 24rpx;
      color: #8A6A10;
      background: #fef3c7;
      padding: 4rpx 12rpx;
      border-radius: 6rpx;
    }
  }

  .stock-footer {
    display: flex;
    justify-content: space-between;
    padding-top: 20rpx;
    border-top: 1rpx solid #f0f0f0;

    .stock-info {
      text-align: center;

      .label {
        font-size: 22rpx;
        color: #999;
        display: block;
        margin-bottom: 8rpx;
      }

      .value {
        font-size: 26rpx;
        color: #333;
        font-weight: 500;

        &.warning {
          color: #e74c3c;
        }
      }
    }
  }
}

.loading-more, .no-more, .empty {
  text-align: center;
  padding: 40rpx;
  color: #999;
  font-size: 26rpx;
}

.empty {
  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }
}
</style>
