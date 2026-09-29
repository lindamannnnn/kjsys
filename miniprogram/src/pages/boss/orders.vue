<template>
  <view class="container">
    <!-- 类型筛选 -->
    <view class="filter-tabs">
      <view
        v-for="tab in typeTabs"
        :key="tab.value"
        class="tab-item"
        :class="{ active: currentType === tab.value }"
        @click="currentType = tab.value; onRefresh()"
      >
        {{ tab.label }}
      </view>
    </view>

    <!-- 状态筛选 -->
    <view class="filter-tabs">
      <view
        v-for="tab in statusTabs"
        :key="tab.value"
        class="tab-item"
        :class="{ active: currentStatus === tab.value }"
        @click="currentStatus = tab.value; onRefresh()"
      >
        {{ tab.label }}
      </view>
    </view>

    <!-- 日期筛选 -->
    <view class="date-filter">
      <picker mode="date" :value="startDate" @change="onStartDateChange">
        <view class="date-picker">{{ startDate }}</view>
      </picker>
      <text class="separator">至</text>
      <picker mode="date" :value="endDate" @change="onEndDateChange">
        <view class="date-picker">{{ endDate }}</view>
      </picker>
    </view>

    <!-- 单据列表 -->
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
        :key="`${item.kind}-${item._id}`"
        class="order-item"
        @click="goDetail(item)"
      >
        <view class="order-header">
          <view class="order-type" :class="item.kind === 'outbound' ? 'out' : 'in'">
            <text>{{ item.kind === 'outbound' ? '出库' : '入库' }}</text>
          </view>
          <text class="order-no">{{ item.order_no }}</text>
          <text class="order-time">{{ formatDate(item.created_at, 'MM-DD HH:mm') }}</text>
        </view>
        <view class="order-body">
          <text class="material-name">{{ shortNames(item.material_names) }}</text>
          <text class="order-detail">合计数量: {{ item.total_qty || 0 }}</text>
          <text class="order-status" :class="item.status">
            {{ statusText(item.status) }}
          </text>
        </view>
        <view class="order-footer">
          <text class="operator">{{ item.operator_name }}</text>
          <view class="footer-actions">
            <text v-if="item.kind === 'inbound'" class="amount">¥{{ formatMoney(item.total_amount) }}</text>
            <!-- 老板驳回/撤销按钮（待确认状态显示） -->
            <text
              v-if="item.status === 'pending'"
              class="btn-reject"
              @click.stop="rejectOrder(item)"
            >{{ item.kind === 'outbound' ? '驳回' : '撤销' }}</text>
          </view>
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
        <text class="empty-text">暂无单据记录</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { formatDate, formatMoney } from '@/utils/format'
import { statsApi, outboundApi, inboundApi } from '@/utils/api'

// 单据状态文本（与后端 status 取值一致）
function statusText(status) {
  const map = {
    'pending': '待确认',
    'confirmed': '已确认',
    'cancelled': '已撤销',
    'rejected': '已驳回'
  }
  return map[status] || status || ''
}

// 一单多物料，接口返回的是顿号拼接的物料名字符串，过长需截断
function shortNames(names) {
  const text = String(names || '')
  if (!text) return '无明细'
  return text.length > 18 ? `${text.slice(0, 18)}…` : text
}

const currentType = ref('all')
const currentStatus = ref('all')
const typeTabs = [
  { label: '全部', value: 'all' },
  { label: '出库', value: 'outbound' },
  { label: '入库', value: 'inbound' }
]

const statusTabs = [
  { label: '全部状态', value: 'all' },
  { label: '待确认', value: 'pending' },
  { label: '已确认', value: 'confirmed' },
  { label: '已驳回', value: 'rejected' }
]

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

function onStartDateChange(e) {
  startDate.value = e.detail.value
  onRefresh()
}

function onEndDateChange(e) {
  endDate.value = e.detail.value
  onRefresh()
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
    const res = await statsApi.orderFlow({
      page: page.value,
      pageSize: pageSize.value,
      type: currentType.value === 'all' ? '' : currentType.value,
      status: currentStatus.value === 'all' ? '' : currentStatus.value,
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

// 跳转到单据详情
function goDetail(item) {
  const url = item.kind === 'outbound'
    ? `/pages/out/detail?id=${item._id}`
    : `/pages/in/detail?id=${item._id}`
  uni.navigateTo({ url })
}

// 老板驳回出库单 / 撤销入库单
function rejectOrder(item) {
  const isOutbound = item.kind === 'outbound'
  const actionText = isOutbound ? '驳回' : '作废'

  uni.showModal({
    title: `${actionText} ${item.order_no}`,
    editable: true,
    placeholderText: `必须填写${actionText}理由，提交人能收到`,
    confirmText: actionText,
    cancelText: '取消',
    confirmColor: '#e74c3c',
    success: async (res) => {
      if (!res.confirm) return
      const reason = String(res.content || '').trim()
      if (!reason) {
        uni.showToast({ title: `请填写${actionText}理由`, icon: 'none' })
        return
      }
      try {
        if (isOutbound) {
          await outboundApi.reject({ id: item._id, reason })
        } else {
          await inboundApi.cancel({ id: item._id, reason })
        }
        uni.showToast({ title: `已${actionText}`, icon: 'success' })
        onRefresh()
      } catch (err) {
        uni.showToast({ title: err.message || '操作失败', icon: 'none' })
      }
    }
  })
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

.filter-tabs {
  display: flex;
  background: #fff;
  padding: 20rpx;
  gap: 20rpx;

  .tab-item {
    flex: 1;
    text-align: center;
    padding: 16rpx;
    font-size: 26rpx;
    color: #666;
    border-radius: 8rpx;
    background: #f5f5f5;
    transition: all 0.3s;

    &.active {
      background: #8A6A10;
      color: #fff;
      font-weight: 500;
    }
  }
}

.date-filter {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20rpx;
  padding: 20rpx;
  background: #fff;
  border-top: 1rpx solid #f0f0f0;

  .date-picker {
    background: #f5f5f5;
    border-radius: 8rpx;
    padding: 12rpx 24rpx;
    font-size: 24rpx;
    color: #333;
  }

  .separator {
    color: #999;
    font-size: 24rpx;
  }
}

.order-list {
  padding: 20rpx;
  height: calc(100vh - 220rpx);
}

.order-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .order-header {
    display: flex;
    align-items: center;
    gap: 16rpx;
    margin-bottom: 16rpx;

    .order-type {
      font-size: 22rpx;
      padding: 6rpx 12rpx;
      border-radius: 6rpx;
      color: #fff;

      &.out {
        background: #e74c3c;
      }

      &.in {
        background: #27ae60;
      }
    }

    .order-no {
      flex: 1;
      font-size: 26rpx;
      font-weight: 500;
      color: #333;
    }

    .order-time {
      font-size: 22rpx;
      color: #999;
    }
  }

  .order-body {
    margin-bottom: 16rpx;

    .material-name {
      font-size: 28rpx;
      color: #333;
      display: block;
    }

    .order-detail {
      font-size: 24rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;
    }

    .order-status {
      font-size: 22rpx;
      padding: 4rpx 12rpx;
      border-radius: 6rpx;
      margin-top: 8rpx;
      display: inline-block;

      &.pending {
        background: #fff3cd;
        color: #856404;
      }

      &.approved {
        background: #d4edda;
        color: #155724;
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

      &.completed {
        background: #d1ecf1;
        color: #0c5460;
      }
    }
  }

  .order-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .operator {
      font-size: 22rpx;
      color: #999;
    }

    .footer-actions {
      display: flex;
      align-items: center;
      gap: 16rpx;

      .amount {
        font-size: 26rpx;
        font-weight: bold;
        color: #0B4F95;
      }

      .btn-reject {
        font-size: 22rpx;
        color: #e74c3c;
        padding: 4rpx 16rpx;
        border: 1rpx solid #e74c3c;
        border-radius: 8rpx;
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
