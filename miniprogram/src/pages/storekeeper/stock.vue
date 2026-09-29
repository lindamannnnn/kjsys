<template>
  <view class="container">
    <!-- 仓库切换 -->
    <view class="warehouse-bar">
      <text
        v-for="w in warehouses"
        :key="w._id"
        class="warehouse-tab"
        :class="{ active: currentWarehouse === w._id }"
        @click="onWarehouseChange(w._id)"
      >{{ w.name }}</text>
    </view>

    <!-- 搜索 -->
    <view class="search-bar">
      <input
        v-model="keyword"
        class="search-input"
        placeholder="搜索物料"
        placeholder-class="placeholder"
        @input="onSearch"
      />
    </view>

    <!-- 库存列表 -->
    <scroll-view
      class="stock-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in displayList"
        :key="item._id"
        class="stock-card"
      >
        <view class="stock-info">
          <text class="material-name">{{ item.name }}</text>
          <text class="material-spec">{{ item.spec }} | {{ item.category }}</text>
        </view>
        <view class="stock-qty">
          <text class="qty-value" :class="{ warning: item.current_stock <= item.warning_stock }">
            {{ item.current_stock }}
          </text>
          <text class="qty-unit">{{ item.unit }}</text>
          <text v-if="item.current_stock <= item.warning_stock" class="warning-tag">预警</text>
        </view>
      </view>

      <view v-if="displayList.length === 0" class="empty">
        <text class="empty-icon">📦</text>
        <text class="empty-text">暂无物料</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { statsApi, warehouseApi } from '@/utils/api'

const warehouses = ref([])
const currentWarehouse = ref('')
const keyword = ref('')
const displayList = ref([])
const refreshing = ref(false)

function onWarehouseChange(id) {
  currentWarehouse.value = id
  loadStock()
}

function onSearch() {
  loadStock()
}

// 库存台账（真实接口）
async function loadStock() {
  try {
    const res = await statsApi.stockList({
      page: 1,
      pageSize: 100,
      keyword: keyword.value,
      warehouse_id: currentWarehouse.value || undefined
    })
    displayList.value = res.list || []
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    refreshing.value = false
  }
}

async function loadWarehouses() {
  const res = await warehouseApi.list()
  warehouses.value = (res.list || []).map((w) => ({ _id: w._id || w.id, name: w.name }))
  if (warehouses.value.length && !currentWarehouse.value) {
    currentWarehouse.value = warehouses.value[0]._id
  }
}

function onRefresh() {
  loadStock()
}

onMounted(async () => {
  try {
    await loadWarehouses()
  } catch (err) {
    uni.showToast({ title: err.message || '仓库加载失败', icon: 'none' })
  }
  loadStock()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
}

.warehouse-bar {
  display: flex;
  background: #fff;
  padding: 20rpx;
  gap: 20rpx;
  border-bottom: 1rpx solid #f0f0f0;

  .warehouse-tab {
    flex: 1;
    text-align: center;
    padding: 16rpx;
    font-size: 28rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 12rpx;

    &.active {
      background: #6b5b95;
      color: #fff;
      font-weight: bold;
    }
  }
}

.search-bar {
  padding: 20rpx;
  background: #fff;
  border-bottom: 1rpx solid #f0f0f0;

  .search-input {
    background: #f5f5f5;
    border-radius: 40rpx;
    padding: 16rpx 24rpx;
    font-size: 28rpx;
  }

  .placeholder {
    color: #999;
  }
}

.stock-list {
  padding: 20rpx;
  height: calc(100vh - 200rpx);
}

.stock-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .stock-info {
    flex: 1;

    .material-name {
      font-size: 30rpx;
      font-weight: 500;
      color: #333;
      display: block;
    }

    .material-spec {
      font-size: 24rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }
  }

  .stock-qty {
    text-align: right;

    .qty-value {
      font-size: 40rpx;
      font-weight: bold;
      color: #333;

      &.warning {
        color: #e74c3c;
      }
    }

    .qty-unit {
      font-size: 22rpx;
      color: #999;
      margin-left: 4rpx;
    }

    .warning-tag {
      display: block;
      font-size: 20rpx;
      color: #e74c3c;
      margin-top: 4rpx;
    }
  }
}

.empty {
  text-align: center;
  padding: 80rpx 0;

  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }

  .empty-text {
    font-size: 26rpx;
    color: #999;
  }
}
</style>
