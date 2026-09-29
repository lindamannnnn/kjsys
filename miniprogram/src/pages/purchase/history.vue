<template>
  <view class="container">
    <!-- 日期筛选 + 导出 -->
    <view class="filter-bar">
      <picker mode="date" :value="startDate" @change="onStartDateChange">
        <view class="date-picker">{{ startDate }}</view>
      </picker>
      <text class="separator">至</text>
      <picker mode="date" :value="endDate" @change="onEndDateChange">
        <view class="date-picker">{{ endDate }}</view>
      </picker>
      <picker class="status-picker" :range="statusOptions" range-key="label" @change="onStatusChange">
        <view class="date-picker">{{ currentStatusLabel }}</view>
      </picker>
      <button class="btn-export" @click="exportCSV">导出</button>
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
          <text class="material-name">{{ item.material_names || '无明细' }}</text>
          <text class="material-spec">共 {{ item.item_count }} 项</text>
          <text class="order-quantity">数量: {{ item.total_qty }}</text>
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
import { ref, computed, onMounted } from 'vue'
import { formatDate } from '@/utils/format'
import { inboundApi, statusText } from '@/utils/api'

const startDate = ref(getDefaultDate(-7))
const endDate = ref(getDefaultDate(0))
const status = ref('')
const orderList = ref([])
const page = ref(1)
const pageSize = ref(20)
const loadingMore = ref(false)
const noMore = ref(false)
const refreshing = ref(false)

const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '待确认', value: 'pending' },
  { label: '已确认', value: 'confirmed' },
  { label: '已撤销', value: 'cancelled' }
]

const currentStatusLabel = computed(() => {
  const hit = statusOptions.find((s) => s.value === status.value)
  return hit ? hit.label : '全部状态'
})

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

function onStatusChange(e) {
  const idx = Number(e.detail.value)
  status.value = statusOptions[idx] ? statusOptions[idx].value : ''
  onRefresh()
}

function goDetail(id) {
  uni.navigateTo({ url: `/pages/purchase/detail?id=${id}` })
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

// 给单据补充聚合字段，便于列表展示与导出
function decorate(order) {
  const items = order.items || []
  return {
    ...order,
    item_count: items.length,
    total_qty: items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0),
    material_names: items.map((it) => it.material_name).filter(Boolean).join('、')
  }
}

// 加载入库单（采购走入库模块）
async function loadOrders() {
  loadingMore.value = true
  try {
    const res = await inboundApi.list({
      page: page.value,
      pageSize: pageSize.value,
      status: status.value,
      startDate: startDate.value,
      endDate: endDate.value
    })
    const list = (res.list || []).map(decorate)
    orderList.value = page.value === 1 ? list : [...orderList.value, ...list]
    noMore.value = list.length === 0 || orderList.value.length >= (res.total || 0)
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loadingMore.value = false
    refreshing.value = false
  }
}

// 导出 CSV（小程序环境复制到剪贴板）
function exportCSV() {
  if (orderList.value.length === 0) {
    uni.showToast({ title: '暂无数据可导出', icon: 'none' })
    return
  }

  const data = orderList.value.map((item) => ({
    '单号': item.order_no,
    '物料名称': item.material_names,
    '明细项数': item.item_count,
    '总数量': item.total_qty,
    '合计金额': item.total_price,
    '供应商': item.supplier || '',
    '操作员': item.operator_name,
    '状态': statusText(item.status),
    '创建时间': formatDate(item.created_at, 'YYYY-MM-DD HH:mm')
  }))

  const headers = Object.keys(data[0])
  const content = [
    headers.join(','),
    ...data.map((row) => headers.map((h) => {
      const val = row[h]
      if (val === null || val === undefined) return ''
      const str = String(val)
      return str.includes(',') ? `"${str}"` : str
    }).join(','))
  ].join('\n')

  uni.setClipboardData({
    data: content,
    success: () => {
      uni.showToast({ title: '已复制到剪贴板', icon: 'success', duration: 2000 })
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

  .btn-export {
    background: #0B4F95;
    color: #fff;
    font-size: 24rpx;
    padding: 12rpx 24rpx;
    border-radius: 8rpx;
    margin-left: auto;

    &::after {
      border: none;
    }
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
