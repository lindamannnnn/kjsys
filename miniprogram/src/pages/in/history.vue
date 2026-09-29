<template>
  <view class="container">
    <!-- 日期筛选 -->
    <view class="filter-bar">
      <picker mode="date" :value="startDate" @change="onStartDateChange">
        <view class="date-picker">{{ startDate }}</view>
      </picker>
      <text class="separator">至</text>
      <picker mode="date" :value="endDate" @change="onEndDateChange">
        <view class="date-picker">{{ endDate }}</view>
      </picker>
    </view>

    <!-- 入库单列表 -->
    <scroll-view
      class="order-list"
      scroll-y
      @scrolltolower="loadMore"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in orderList"
        :key="item._id"
        class="order-item"
        @click="goDetail(item._id)"
      >
        <view class="order-header">
          <text class="order-no">{{ item.order_no }}</text>
          <view class="header-right">
            <text class="order-status" :class="item.status">{{ statusText(item.status) }}</text>
            <text class="order-amount">¥{{ item.total_price }}</text>
          </view>
        </view>
        <view class="order-body">
          <text class="material-name">{{ itemsSummary(item) }}</text>
          <text class="material-spec">{{ item.warehouse_name }}</text>
          <text class="order-quantity">合计数量: {{ totalQty(item) }}</text>
          <!-- 对账要看单价（原来只显示总金额，得一单单点进去看） -->
          <text class="order-price">{{ priceSummary(item) }}</text>
        </view>
        <view class="order-footer">
          <text class="order-time">{{ formatDate(item.created_at, 'YYYY-MM-DD HH:mm') }}</text>
          <text class="order-supplier">{{ item.supplier || '无供应商' }}</text>
        </view>
      </view>

      <view v-if="loadingMore" class="loading-more">
        <text>加载中...</text>
      </view>

      <view v-else-if="noMore" class="no-more">
        <text>没有更多了</text>
      </view>

      <view v-else-if="orderList.length === 0" class="empty">
        <text class="empty-icon">📋</text>
        <text class="empty-text">暂无入库记录</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { formatDate } from '@/utils/format'
import { inboundApi, statusText } from '@/utils/api'

const startDate = ref(getDefaultDate(-7))
const endDate = ref(getDefaultDate(0))
const orderList = ref([])
const page = ref(1)
const pageSize = ref(20)
const loadingMore = ref(false)
const noMore = ref(false)
const refreshing = ref(false)

function getDefaultDate(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().split('T')[0]
}

function itemsSummary(item) {
  const list = item.items || []
  if (!list.length) return '无明细'
  if (list.length === 1) {
    const i = list[0]
    return `${i.material_name}${i.material_spec ? ' / ' + i.material_spec : ''}`
  }
  const total = list.reduce((s, i) => s + Number(i.quantity || 0), 0)
  return `${list[0].material_name} 等 ${list.length} 项（共 ${total}）`
}

function totalQty(item) {
  return (item.items || []).reduce((s, i) => s + Number(i.quantity || 0), 0)
}

/**
 * 列表上能看到的单价信息（李娜报的 P2：只显示总金额，对账得一单单点进去）
 * 一单一项 → 直接给单价与金额；一单多项 → 说清有几项，提醒点开看每项单价。
 * 列表接口本来就带回了 items（含 unit_price），不需要额外请求。
 */
function priceSummary(item) {
  const list = item.items || []
  if (!list.length) return ''
  if (list.length === 1) {
    const i = list[0]
    if (i.unit_price === null || i.unit_price === undefined) return '单价未填'
    return `单价 ¥${Number(i.unit_price).toFixed(2)} × ${i.quantity} = ¥${Number(i.total_price || 0).toFixed(2)}`
  }
  return `${list.length} 项物料，点开看每项单价`
}

function onStartDateChange(e) {
  startDate.value = e.detail.value
  onRefresh()
}

function onEndDateChange(e) {
  endDate.value = e.detail.value
  onRefresh()
}

function goDetail(id) {
  uni.navigateTo({ url: `/pages/in/detail?id=${id}` })
}

function onRefresh() {
  page.value = 1
  noMore.value = false
  loadOrders()
}

function loadMore() {
  if (!noMore.value && !loadingMore.value) {
    page.value++
    loadOrders()
  }
}

async function loadOrders() {
  if (loadingMore.value) return

  loadingMore.value = true
  try {
    const res = await inboundApi.list({
      page: page.value,
      pageSize: pageSize.value,
      startDate: startDate.value,
      endDate: endDate.value
    })
    const list = res.list || []
    orderList.value = page.value === 1 ? list : [...orderList.value, ...list]
    noMore.value = list.length === 0 || orderList.value.length >= (res.total || 0)
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loadingMore.value = false
    refreshing.value = false
  }
}

onMounted(() => {
  loadOrders()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
}

.filter-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20rpx;
  padding: 20rpx;
  background: #fff;

  .date-picker {
    background: #f5f5f5;
    border-radius: 8rpx;
    padding: 16rpx 30rpx;
    font-size: 26rpx;
    color: #333;
  }

  .separator {
    color: #999;
    font-size: 26rpx;
  }
}

.order-list {
  padding: 20rpx;
  height: calc(100vh - 120rpx);
}

.order-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .order-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20rpx;

    .order-no {
      font-size: 28rpx;
      font-weight: 500;
      color: #333;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 16rpx;
    }

    .order-status {
      font-size: 22rpx;
      padding: 6rpx 14rpx;
      border-radius: 8rpx;

      &.pending {
        background: #fff3cd;
        color: #856404;
      }

      &.confirmed {
        background: #d4edda;
        color: #155724;
      }

      &.cancelled {
        background: #e2e3e5;
        color: #4b5157;
      }

      &.rejected {
        background: #f8d7da;
        color: #721c24;
      }
    }

    .order-amount {
      font-size: 28rpx;
      font-weight: bold;
      color: #0B4F95;
    }
  }

  .order-body {
    margin-bottom: 20rpx;

    .material-name {
      font-size: 30rpx;
      color: #333;
      display: block;
    }

    .material-spec {
      font-size: 24rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }

    .order-quantity {
      font-size: 26rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;
    }

    .order-price {
      font-size: 26rpx;
      color: #0B4F95;
      margin-top: 8rpx;
      display: block;
    }
  }

  .order-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .order-time {
      font-size: 24rpx;
      color: #999;
    }

    .order-supplier {
      font-size: 24rpx;
      color: #0B4F95;
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
