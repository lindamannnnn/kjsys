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

    <!-- 状态筛选（流程重构 V2：领料线多了「待拣货 / 待收货」，找单要能按环节筛） -->
    <scroll-view class="status-bar" scroll-x>
      <text
        v-for="t in statusTabs"
        :key="t.value"
        class="status-tab"
        :class="{ active: currentStatus === t.value }"
        @click="switchStatus(t.value)"
      >{{ t.label }}</text>
    </scroll-view>

    <!-- 出库单列表 -->
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
          <text class="order-status" :class="item.status">{{ statusText(item.status) }}</text>
        </view>
        <view class="order-body">
          <text class="material-name">{{ itemsSummary(item) }}</text>
          <text class="material-spec">{{ item.warehouse_name }}</text>
          <text class="order-quantity">合计数量: {{ totalQty(item) }}</text>
        </view>
        <view class="order-footer">
          <text class="order-time">{{ formatDate(item.created_at, 'YYYY-MM-DD HH:mm') }}</text>
          <view class="footer-right">
            <text class="order-type">{{ typeText(item.type) }}</text>
            <!-- 再来一单（2026-10-09 新增）：把原单物料与数量带进领料页，
                 重复领用同一批料不用再一个个搜 -->
            <text class="btn-repick" @click.stop="onRepick(item)">再来一单</text>
            <!-- 待确认的单直接在列表就能撤（自己的记录页，都是本人单；详情页里也有） -->
            <text
              v-if="item.status === 'pending'"
              class="btn-cancel-mini"
              @click.stop="onCancelOrder(item)"
            >撤销</text>
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
        <text class="empty-text">暂无出库记录</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { formatDate } from '@/utils/format'
import { outboundApi, statusText, typeText } from '@/utils/api'

const startDate = ref(getDefaultDate(-7))
const endDate = ref(getDefaultDate(0))
const orderList = ref([])
const page = ref(1)
const pageSize = ref(20)
const loadingMore = ref(false)
const noMore = ref(false)
const refreshing = ref(false)
const currentStatus = ref('')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '待确认', value: 'pending' },
  { label: '待拣货', value: 'picking' },
  { label: '待收货', value: 'receiving' },
  { label: '已完成', value: 'completed' },
  { label: '已驳回', value: 'rejected' }
]

function switchStatus(v) {
  if (currentStatus.value === v) return
  currentStatus.value = v
  page.value = 1
  noMore.value = false
  orderList.value = []
  loadOrders()
}

function getDefaultDate(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().split('T')[0]
}

// 状态与类型文案统一走 utils/api（保证和小程序其它页面、后端说法一致）

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

function onStartDateChange(e) {
  startDate.value = e.detail.value
  onRefresh()
}

function onEndDateChange(e) {
  endDate.value = e.detail.value
  onRefresh()
}

function goDetail(id) {
  uni.navigateTo({ url: `/pages/out/detail?id=${id}` })
}

/** 再来一单：把原单明细预填进领料页（页面用 onLoad 读 from_order） */
function onRepick(item) {
  uni.navigateTo({ url: `/pages/out/submit?from_order=${item._id}` })
}

/** 列表上直接撤销待确认单（@click.stop 拦住跳详情） */
function onCancelOrder(item) {
  uni.showModal({
    title: '撤销此单',
    editable: true,
    placeholderText: '撤销原因（选填）',
    confirmText: '撤销',
    cancelText: '再想想',
    success: async (res) => {
      if (!res.confirm) return
      try {
        await outboundApi.cancel({ id: item._id, reason: String(res.content || '').trim() })
        uni.showToast({ title: '已撤销', icon: 'success' })
        onRefresh()
      } catch (err) {
        uni.showToast({ title: err.message || '撤销失败', icon: 'none', duration: 3000 })
      }
    }
  })
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
    const res = await outboundApi.list({
      page: page.value,
      pageSize: pageSize.value,
      startDate: startDate.value,
      endDate: endDate.value,
      ...(currentStatus.value ? { status: currentStatus.value } : {})
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

// 首次进入即加载（onMounted 兜底，防止页面生命周期在某些端不触发导致空白）
// 之后每次页面重新显示时刷新（含从子页面返回），所以点完确认回到工作台红点会同步
const __pageShowHandler = () => {
  loadOrders()
}
onMounted(() => {
  __pageShowHandler()      // 首屏一定加载（onMounted 兜底，不依赖任何注册成功与否）
  onShow(__pageShowHandler)  // 之后每次页面重新显示（含从子页返回）都刷新
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

.status-bar {
  background: #fff;
  padding: 16rpx 20rpx;
  white-space: nowrap;
  border-top: 1rpx solid #f5f5f5;

  .status-tab {
    display: inline-block;
    padding: 10rpx 24rpx;
    margin-right: 14rpx;
    font-size: 24rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 30rpx;

    &.active {
      background: #0F7A3D;
      color: #fff;
    }
  }
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

    .order-status {
      font-size: 24rpx;
      padding: 8rpx 16rpx;
      border-radius: 8rpx;

      &.pending {
        background: #fff3cd;
        color: #856404;
      }

      &.picking {
        background: #efeaf7;
        color: #5b4b8a;
      }

      &.receiving {
        background: #d1ecf1;
        color: #0c5460;
      }

      &.confirmed {
        background: #d4edda;
        color: #155724;
      }

      &.approved {
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

    .footer-right {
      display: flex;
      align-items: center;
      gap: 16rpx;
    }

    .order-type {
      font-size: 24rpx;
      color: #0F7A3D;
      font-weight: 500;
    }

    .btn-cancel-mini {
      font-size: 24rpx;
      color: #e74c3c;
      border: 1rpx solid #f5c6c0;
      border-radius: 8rpx;
      padding: 6rpx 20rpx;
    }

    /* 再来一单：绿色描边，与红色的「撤销」区分开，避免误点 */
    .btn-repick {
      font-size: 24rpx;
      color: #0F7A3D;
      border: 1rpx solid #b7e0c6;
      border-radius: 8rpx;
      padding: 6rpx 20rpx;
      margin-right: 12rpx;
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
